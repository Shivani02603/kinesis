"""Structural validation — pure graph traversal against Neo4j, no LLM.

Two independent checks, matching the brief's "flag orphans and gaps":
- stage gaps: a Stage node missing an incoming and/or outgoing PRECEDES edge
- orphans: any entity node with zero relationships of any kind

Both only flag candidates for human review. Whether a flagged stage is a
legitimate start/end node, or an orphan asset is genuinely expected to be
unconnected, is a human judgment made during confirmation — not decided here.
Once a human has acknowledged a specific stage/orphan (either as "yeh legitimate
hai" or "yeh fix chahiye"), that id is passed in via `acknowledged_ids` so it
stops being re-surfaced as a fresh question on every run.
"""

from dataclasses import dataclass

from .graph_store import GraphStore

_STAGE_GAP_QUERY = """
MATCH (s:Stage {project_id: $project_id})
OPTIONAL MATCH (s)<-[:PRECEDES]-(pred)
OPTIONAL MATCH (s)-[:PRECEDES]->(succ)
WITH s, count(DISTINCT pred) AS pred_count, count(DISTINCT succ) AS succ_count
WHERE pred_count = 0 OR succ_count = 0
RETURN s.id AS id, s.name AS name, pred_count AS pred_count, succ_count AS succ_count
"""

_ORPHAN_QUERY = """
MATCH (n {project_id: $project_id})
WHERE NOT (n)--()
RETURN n.id AS id, n.name AS name, labels(n)[0] AS label
"""


@dataclass
class StageGap:
    stage_id: str
    stage_name: str
    missing: str  # "predecessor" | "successor" | "both"


@dataclass
class OrphanEntity:
    entity_id: str
    entity_name: str
    entity_label: str


def find_stage_gaps(
    store: GraphStore, project_id: str, acknowledged_ids: set[str] | None = None
) -> list[StageGap]:
    acknowledged_ids = acknowledged_ids or set()
    gaps = []
    for record in store.run(_STAGE_GAP_QUERY, project_id=project_id):
        if record["id"] in acknowledged_ids:
            continue
        pred_count, succ_count = record["pred_count"], record["succ_count"]
        if pred_count == 0 and succ_count == 0:
            missing = "both"
        elif pred_count == 0:
            missing = "predecessor"
        else:
            missing = "successor"
        gaps.append(StageGap(stage_id=record["id"], stage_name=record["name"], missing=missing))
    return gaps


def find_orphan_entities(
    store: GraphStore, project_id: str, acknowledged_ids: set[str] | None = None
) -> list[OrphanEntity]:
    acknowledged_ids = acknowledged_ids or set()
    return [
        OrphanEntity(entity_id=r["id"], entity_name=r["name"], entity_label=r["label"])
        for r in store.run(_ORPHAN_QUERY, project_id=project_id)
        if r["id"] not in acknowledged_ids
    ]
