"""Graph store — the factory graph, scoped per project so multiple clients
never mix.

Backed by SQLite (two tables: graph_nodes, graph_edges), not a graph database.
The queries this system actually runs are all shallow — fetch a project's nodes
and edges, count by label, and a few one-hop checks (does this stage have a
predecessor/successor? does this node have any relationship? which signals
measure this asset?) — none need graph-database machinery. SQLite is already the
app's store, so this removes an always-on cloud dependency (and the connection
drops / auto-pause that came with Neo4j Aura Free) with no loss of function.

Idempotent throughout (INSERT OR REPLACE by primary key), so re-running the
pipeline over the same sources never creates duplicates — same guarantee the
old MERGE-based version gave.
"""

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

from .schemas import Entity, Relationship

# One file shared with the rest of the app (projects, users, training runs) —
# one database to back up and deploy. Override with GRAPH_DB_PATH if needed.
_DEFAULT_DB = Path(__file__).parent.parent / "backend" / "app.db"

# The six relationship types the schema allows, stored uppercase like the old
# Neo4j relationship types so nothing downstream that compares on them changes.
_REL_TYPES = ("PRECEDES", "PART_OF", "MEASURES", "PRODUCES", "CONSUMES", "REPORTS_TO")


class GraphStore:
    def __init__(self, db_path: str | None = None):
        self._db_path = str(db_path or os.environ.get("GRAPH_DB_PATH") or _DEFAULT_DB)
        self._init_schema()

    @contextmanager
    def _connect(self):
        conn = sqlite3.connect(self._db_path, timeout=10.0)
        conn.row_factory = sqlite3.Row
        try:
            # WAL lets the graph tables be read while another connection (e.g. the
            # rest of the app writing app.db) has a write open, instead of blocking.
            conn.execute("PRAGMA journal_mode=WAL")
            yield conn
            conn.commit()
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS graph_nodes (
                    project_id TEXT NOT NULL,
                    id TEXT NOT NULL,
                    label TEXT NOT NULL,
                    name TEXT,
                    perspective TEXT,
                    notes TEXT,
                    source TEXT,
                    confidence REAL,
                    source_reference TEXT,
                    PRIMARY KEY (project_id, id)
                );
                CREATE TABLE IF NOT EXISTS graph_edges (
                    project_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    target TEXT NOT NULL,
                    type TEXT NOT NULL,
                    rel_source TEXT,
                    PRIMARY KEY (project_id, source, target, type)
                );
                CREATE INDEX IF NOT EXISTS idx_edges_project ON graph_edges(project_id);
                CREATE INDEX IF NOT EXISTS idx_nodes_project_label ON graph_nodes(project_id, label);
                """
            )

    def close(self) -> None:
        # Connections are per-operation (opened and closed in _connect), so there's
        # nothing to keep open — kept for interface compatibility with callers.
        pass

    # ---- writes ----------------------------------------------------------

    def upsert_entity(self, project_id: str, entity: Entity) -> None:
        label = entity.entity_type.value.capitalize()
        with self._connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO graph_nodes "
                "(project_id, id, label, name, perspective, notes, source, confidence, source_reference) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    project_id,
                    entity.id,
                    label,
                    entity.name,
                    entity.attributes.perspective.value if entity.attributes.perspective else None,
                    entity.attributes.notes,
                    entity.source,
                    entity.confidence,
                    entity.attributes.source_reference,
                ),
            )

    def upsert_relationship(self, project_id: str, relationship: Relationship) -> None:
        rel_type = relationship.relationship_type.value.upper()
        with self._connect() as conn:
            # Mirror the old MATCH...MERGE: an edge is only written when BOTH its
            # endpoints already exist — a relationship to an unknown node is a no-op,
            # never a dangling edge.
            present = {
                r["id"]
                for r in conn.execute(
                    "SELECT id FROM graph_nodes WHERE project_id = ? AND id IN (?, ?)",
                    (project_id, relationship.from_id, relationship.to_id),
                ).fetchall()
            }
            if relationship.from_id not in present or relationship.to_id not in present:
                return
            conn.execute(
                "INSERT OR REPLACE INTO graph_edges (project_id, source, target, type, rel_source) "
                "VALUES (?, ?, ?, ?, ?)",
                (project_id, relationship.from_id, relationship.to_id, rel_type, relationship.source),
            )

    def merge_node_into(self, project_id: str, absorbed_id: str, canonical_id: str) -> None:
        """Redirect every relationship off absorbed_id onto canonical_id, then delete
        the absorbed node. Used when a human confirms an ambiguous merge."""
        with self._connect() as conn:
            # source_reference only means something together with the file it names a
            # column in ("source"): if the absorbed node is the one holding real data,
            # carry that pair onto the canonical rather than losing it on delete.
            can = conn.execute(
                "SELECT source_reference FROM graph_nodes WHERE project_id = ? AND id = ?",
                (project_id, canonical_id),
            ).fetchone()
            ab = conn.execute(
                "SELECT source, source_reference FROM graph_nodes WHERE project_id = ? AND id = ?",
                (project_id, absorbed_id),
            ).fetchone()
            if can is not None and ab is not None and can["source_reference"] is None and ab["source_reference"] is not None:
                conn.execute(
                    "UPDATE graph_nodes SET source_reference = ?, source = ? WHERE project_id = ? AND id = ?",
                    (ab["source_reference"], ab["source"], project_id, canonical_id),
                )

            # Redirect edges touching absorbed to canonical, dropping any that would
            # become a self-loop (canonical→canonical is never meaningful). INSERT OR
            # REPLACE dedups against edges the canonical already has.
            edges = conn.execute(
                "SELECT source, target, type, rel_source FROM graph_edges "
                "WHERE project_id = ? AND (source = ? OR target = ?)",
                (project_id, absorbed_id, absorbed_id),
            ).fetchall()
            for e in edges:
                new_source = canonical_id if e["source"] == absorbed_id else e["source"]
                new_target = canonical_id if e["target"] == absorbed_id else e["target"]
                if new_source != new_target:
                    conn.execute(
                        "INSERT OR REPLACE INTO graph_edges (project_id, source, target, type, rel_source) "
                        "VALUES (?, ?, ?, ?, ?)",
                        (project_id, new_source, new_target, e["type"], e["rel_source"]),
                    )
            conn.execute(
                "DELETE FROM graph_edges WHERE project_id = ? AND (source = ? OR target = ?)",
                (project_id, absorbed_id, absorbed_id),
            )
            conn.execute("DELETE FROM graph_nodes WHERE project_id = ? AND id = ?", (project_id, absorbed_id))

    def delete_project(self, project_id: str) -> None:
        with self._connect() as conn:
            conn.execute("DELETE FROM graph_edges WHERE project_id = ?", (project_id,))
            conn.execute("DELETE FROM graph_nodes WHERE project_id = ?", (project_id,))

    # ---- reads -----------------------------------------------------------

    def fetch_entities(self, project_id: str) -> list[Entity]:
        """All entities stored for this project — the pool new extractions resolve
        against, so re-running never creates duplicates."""
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM graph_nodes WHERE project_id = ?", (project_id,)).fetchall()
        entities = []
        for n in rows:
            entities.append(
                Entity(
                    entity_type=n["label"].lower(),
                    id=n["id"],
                    name=n["name"],
                    attributes={
                        "perspective": n["perspective"],
                        "notes": n["notes"] or "",
                        "source_reference": n["source_reference"],
                    },
                    source=n["source"] or "",
                    confidence=n["confidence"] if n["confidence"] is not None else 0.5,
                )
            )
        return entities

    def count_nodes(self, project_id: str, label: str) -> int:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM graph_nodes WHERE project_id = ? AND label = ?",
                (project_id, label),
            ).fetchone()
        return row["c"] if row else 0

    def fetch_graph(self, project_id: str) -> dict:
        """Nodes + edges for this project, shaped for frontend graph rendering."""
        with self._connect() as conn:
            nodes = [
                dict(r)
                for r in conn.execute(
                    "SELECT id, name, label, perspective, confidence, source_reference "
                    "FROM graph_nodes WHERE project_id = ?",
                    (project_id,),
                ).fetchall()
            ]
            # source <> target excludes self-loops: a confirmed merge can leave one
            # behind when the two merged entities had a direct relationship to each
            # other — an entity related to itself is only ever a merge artifact.
            edges = [
                dict(r)
                for r in conn.execute(
                    "SELECT source, target, type FROM graph_edges WHERE project_id = ? AND source <> target",
                    (project_id,),
                ).fetchall()
            ]
        return {"nodes": nodes, "edges": edges}

    # ---- one-hop traversals the rest of the engine needs -----------------

    def stage_gap_candidates(self, project_id: str) -> list[dict]:
        """Every Stage missing an incoming and/or outgoing PRECEDES — candidate
        gaps for a human to judge (same output the old Cypher check produced)."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT n.id AS id, n.name AS name,
                  (SELECT COUNT(*) FROM graph_edges e
                     WHERE e.project_id = n.project_id AND e.type = 'PRECEDES'
                       AND e.target = n.id AND e.source <> n.id) AS pred_count,
                  (SELECT COUNT(*) FROM graph_edges e
                     WHERE e.project_id = n.project_id AND e.type = 'PRECEDES'
                       AND e.source = n.id AND e.target <> n.id) AS succ_count
                FROM graph_nodes n
                WHERE n.project_id = ? AND n.label = 'Stage'
                """,
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows if r["pred_count"] == 0 or r["succ_count"] == 0]

    def orphan_candidates(self, project_id: str) -> list[dict]:
        """Nodes with no relationship of any kind — candidate orphans for review."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, name, label FROM graph_nodes n
                WHERE n.project_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM graph_edges e
                    WHERE e.project_id = n.project_id AND (e.source = n.id OR e.target = n.id)
                  )
                """,
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    def signals_by_asset(self, project_id: str) -> dict[str, list[str]]:
        """asset_name -> [signal names that MEASURE it]. For maintenance windows."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT a.name AS asset_name, s.name AS signal_name
                FROM graph_nodes a
                LEFT JOIN graph_edges e
                  ON e.project_id = a.project_id AND e.target = a.id AND e.type = 'MEASURES'
                LEFT JOIN graph_nodes s
                  ON s.project_id = a.project_id AND s.id = e.source AND s.label = 'Signal'
                WHERE a.project_id = ? AND a.label = 'Asset'
                """,
                (project_id,),
            ).fetchall()
        out: dict[str, list[str]] = {}
        for r in rows:
            out.setdefault(r["asset_name"], [])
            if r["signal_name"]:
                out[r["asset_name"]].append(r["signal_name"])
        return out

    def signals_with_data_reference(self, project_id: str) -> list[dict]:
        """Every Signal that carries a source_reference (a column that actually holds
        recorded values), with the asset it measures if that link exists. The
        data-presence half of feasibility — a business-event signal legitimately has
        no asset."""
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT s.id AS signal_id, s.name AS signal_name, s.notes AS signal_notes,
                       s.source AS source_file, s.source_reference AS source_column,
                       a.name AS asset_name
                FROM graph_nodes s
                LEFT JOIN graph_edges e
                  ON e.project_id = s.project_id AND e.source = s.id AND e.type = 'MEASURES'
                LEFT JOIN graph_nodes a
                  ON a.project_id = s.project_id AND a.id = e.target AND a.label = 'Asset'
                WHERE s.project_id = ? AND s.label = 'Signal' AND s.source_reference IS NOT NULL
                """,
                (project_id,),
            ).fetchall()
        return [dict(r) for r in rows]
