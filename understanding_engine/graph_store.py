"""Neo4j graph assembly — scoped per project so multiple clients never mix.

MERGE-based throughout, so re-running the pipeline over the same fixtures is
idempotent. Every node carries a project_id property and every query filters
on it; two projects sharing one Aura instance never see each other's data.
"""

import os
import time

from neo4j import GraphDatabase
from neo4j.exceptions import ServiceUnavailable, SessionExpired, TransientError

from .schemas import Entity, Relationship

# Aura silently drops idle connections. Measured behaviour: after a long gap (e.g.
# a 6-minute AutoGluon fit between two graph reads) the DRIVER's own routing table
# goes stale, and every later query fails with "Unable to retrieve routing
# information" — opening a fresh session from the same driver keeps failing, which
# is why only a full process restart used to clear it. So a retry here is not
# enough on its own: the driver itself is rebuilt between attempts. Every query we
# run is idempotent (MERGE / DETACH DELETE / read), so re-running one is safe.
_RETRYABLE = (ServiceUnavailable, SessionExpired, TransientError)
_RETRY_ATTEMPTS = 4
_RETRY_BASE_DELAY = 1.0  # seconds; doubles each attempt


class GraphStore:
    def __init__(self, uri: str | None = None, user: str | None = None, password: str | None = None):
        self._uri = uri or os.environ["NEO4J_URI"]
        self._user = user or os.environ.get("NEO4J_USER", "neo4j")
        self._password = password or os.environ["NEO4J_PASSWORD"]
        self._database = os.environ.get("NEO4J_DATABASE") or None
        self._driver = self._new_driver()

    def _new_driver(self):
        # Capping connection lifetime + keep_alive makes the pool discard sockets
        # before Aura does; the rebuild in run() covers the case where the routing
        # table itself has already gone bad.
        return GraphDatabase.driver(
            self._uri, auth=(self._user, self._password), max_connection_lifetime=300, keep_alive=True
        )

    def _rebuild_driver(self) -> None:
        try:
            self._driver.close()
        except Exception:  # noqa: BLE001 — the old driver is being thrown away anyway
            pass
        self._driver = self._new_driver()

    def close(self) -> None:
        self._driver.close()

    def run(self, query: str, **params) -> list[dict]:
        last_error: Exception | None = None
        for attempt in range(_RETRY_ATTEMPTS):
            try:
                with self._driver.session(database=self._database) as session:
                    return [record.data() for record in session.run(query, **params)]
            except _RETRYABLE as exc:
                last_error = exc
                if attempt == _RETRY_ATTEMPTS - 1:
                    break
                delay = _RETRY_BASE_DELAY * (2 ** attempt)
                print(
                    f"[graph_store] transient Neo4j error (attempt {attempt + 1}/{_RETRY_ATTEMPTS}), "
                    f"rebuilding driver and retrying in {delay:.0f}s: {exc}"
                )
                self._rebuild_driver()
                time.sleep(delay)
        # The driver's own message ("Unable to retrieve routing information") says
        # nothing a user can act on. Once retries + a driver rebuild have all failed,
        # the database really is unreachable, so say that plainly and point at the
        # one thing that actually fixes it.
        raise ServiceUnavailable(
            f"Could not reach the graph database (Neo4j) after {_RETRY_ATTEMPTS} attempts — "
            "the instance is most likely paused or restarting. Check the Neo4j Aura console "
            f"and resume it, then run this again. Driver error: {last_error}"
        ) from last_error

    def upsert_entity(self, project_id: str, entity: Entity) -> None:
        label = entity.entity_type.value.capitalize()
        query = (
            f"MERGE (n:{label} {{project_id: $project_id, id: $id}}) "
            "SET n.name = $name, n.perspective = $perspective, n.notes = $notes, "
            "n.source = $source, n.confidence = $confidence, n.source_reference = $source_reference"
        )
        self.run(
            query,
            project_id=project_id,
            id=entity.id,
            name=entity.name,
            perspective=entity.attributes.perspective.value if entity.attributes.perspective else None,
            notes=entity.attributes.notes,
            source=entity.source,
            confidence=entity.confidence,
            source_reference=entity.attributes.source_reference,
        )

    def upsert_relationship(self, project_id: str, relationship: Relationship) -> None:
        rel_type = relationship.relationship_type.value.upper()
        query = (
            "MATCH (a {project_id: $project_id, id: $from_id}), (b {project_id: $project_id, id: $to_id}) "
            f"MERGE (a)-[r:{rel_type}]->(b) "
            "SET r.source = $source"
        )
        self.run(
            query,
            project_id=project_id,
            from_id=relationship.from_id,
            to_id=relationship.to_id,
            source=relationship.source,
        )

    def fetch_entities(self, project_id: str) -> list[Entity]:
        """All entities currently stored for this project — the pool that new
        extractions get resolved against, so re-running never creates duplicates."""
        query = "MATCH (n {project_id: $project_id}) RETURN n, labels(n)[0] AS label"
        rows = self.run(query, project_id=project_id)
        entities = []
        for row in rows:
            n = row["n"]
            entities.append(
                Entity(
                    entity_type=row["label"].lower(),
                    id=n["id"],
                    name=n["name"],
                    attributes={
                        "perspective": n.get("perspective"),
                        "notes": n.get("notes") or "",
                        "source_reference": n.get("source_reference"),
                    },
                    source=n.get("source", ""),
                    confidence=n.get("confidence", 0.5),
                )
            )
        return entities

    def merge_node_into(self, project_id: str, absorbed_id: str, canonical_id: str) -> None:
        """Redirect every relationship from absorbed_id onto canonical_id, then
        delete the absorbed node. Used when a human confirms an ambiguous merge.

        Done per relationship type in plain Cypher rather than APOC, since APOC
        isn't guaranteed available on Aura Free.
        """
        # source_reference only means something together with the file it names a
        # column in ("source") — same pairing rule as resolution.py's automatic-merge
        # donor fix. Without this, a human confirming a merge where the absorbed node
        # is the one actually holding real data would silently delete that data link —
        # exactly the bug this mirrors and fixes for the human-confirm path.
        self.run(
            """
            MATCH (canonical {project_id: $project_id, id: $canonical_id})
            MATCH (absorbed {project_id: $project_id, id: $absorbed_id})
            WITH canonical, absorbed
            WHERE canonical.source_reference IS NULL AND absorbed.source_reference IS NOT NULL
            SET canonical.source_reference = absorbed.source_reference, canonical.source = absorbed.source
            """,
            project_id=project_id, absorbed_id=absorbed_id, canonical_id=canonical_id,
        )

        rel_types = [
            "PRECEDES", "PART_OF", "MEASURES", "PRODUCES", "CONSUMES", "REPORTS_TO",
        ]
        for rt in rel_types:
            self.run(
                f"""
                MATCH (absorbed {{project_id: $project_id, id: $absorbed_id}})-[r:{rt}]->(target)
                WHERE target.id <> $canonical_id
                MATCH (canonical {{project_id: $project_id, id: $canonical_id}})
                MERGE (canonical)-[:{rt}]->(target)
                """,
                project_id=project_id, absorbed_id=absorbed_id, canonical_id=canonical_id,
            )
            self.run(
                f"""
                MATCH (source)-[r:{rt}]->(absorbed {{project_id: $project_id, id: $absorbed_id}})
                WHERE source.id <> $canonical_id
                MATCH (canonical {{project_id: $project_id, id: $canonical_id}})
                MERGE (source)-[:{rt}]->(canonical)
                """,
                project_id=project_id, absorbed_id=absorbed_id, canonical_id=canonical_id,
            )
        self.run(
            "MATCH (absorbed {project_id: $project_id, id: $absorbed_id}) DETACH DELETE absorbed",
            project_id=project_id, absorbed_id=absorbed_id,
        )

    def count_nodes(self, project_id: str, label: str) -> int:
        """A single COUNT query — used where only the number matters (e.g. a
        companies list), so listing many projects doesn't pull every node and
        edge of every project's graph over the network just to size a badge."""
        rows = self.run(
            f"MATCH (n:{label} {{project_id: $project_id}}) RETURN count(n) AS c",
            project_id=project_id,
        )
        return rows[0]["c"] if rows else 0

    def fetch_graph(self, project_id: str) -> dict:
        """Nodes + edges for this project, shaped for frontend graph rendering."""
        nodes = self.run(
            "MATCH (n {project_id: $project_id}) "
            "RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, "
            "n.perspective AS perspective, n.confidence AS confidence, "
            "n.source_reference AS source_reference",
            project_id=project_id,
        )
        # a.id <> b.id excludes self-loops: a confirmed merge can leave one behind whenever the
        # two merged entities had a direct relationship to each other before merging (e.g. "door
        # part_of furnace" becomes "furnace part_of furnace" if door and furnace get merged) —
        # an entity related to itself is never meaningful, only ever a merge artifact.
        edges = self.run(
            "MATCH (a {project_id: $project_id})-[r]->(b {project_id: $project_id}) "
            "WHERE a.id <> b.id "
            "RETURN a.id AS source, b.id AS target, type(r) AS type",
            project_id=project_id,
        )
        return {"nodes": nodes, "edges": edges}

    def delete_project(self, project_id: str) -> None:
        self.run("MATCH (n {project_id: $project_id}) DETACH DELETE n", project_id=project_id)
