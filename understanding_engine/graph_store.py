"""Neo4j graph assembly — scoped per project so multiple clients never mix.

MERGE-based throughout, so re-running the pipeline over the same fixtures is
idempotent. Every node carries a project_id property and every query filters
on it; two projects sharing one Aura instance never see each other's data.
"""

import os

from neo4j import GraphDatabase

from .schemas import Entity, Relationship


class GraphStore:
    def __init__(self, uri: str | None = None, user: str | None = None, password: str | None = None):
        uri = uri or os.environ["NEO4J_URI"]
        user = user or os.environ.get("NEO4J_USER", "neo4j")
        password = password or os.environ["NEO4J_PASSWORD"]
        self._database = os.environ.get("NEO4J_DATABASE") or None
        # Aura's load balancer silently drops idle connections; without a lifetime
        # cap the pool hands back dead sockets after quiet periods (SessionExpired /
        # "unable to retrieve routing information" on the first query after idling).
        # Capping lifetime + keep_alive makes the pool discard before Aura does.
        self._driver = GraphDatabase.driver(
            uri, auth=(user, password), max_connection_lifetime=300, keep_alive=True
        )

    def close(self) -> None:
        self._driver.close()

    def run(self, query: str, **params) -> list[dict]:
        with self._driver.session(database=self._database) as session:
            return [record.data() for record in session.run(query, **params)]

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
