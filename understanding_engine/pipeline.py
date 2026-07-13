"""End-to-end orchestration: parse -> extract -> resolve -> assemble -> validate.

Pure engine function — it knows nothing about SQLite, HTTP, or projects as a
persistence concept. The caller (the API layer) supplies project_id plus
whatever human decisions have already been made (known_merge_pairs,
known_distinct_pairs, acknowledged_gap_ids, acknowledged_orphan_ids) and gets
back a structured result to persist and render. This keeps the engine testable
on its own and reusable outside a web server.
"""

from dataclasses import dataclass
from pathlib import Path

from .graph_store import GraphStore
from .llm_extraction import extract_from_source
from .parsers import parse_source
from .resolution import (
    AmbiguousMerge,
    ConflictFinding,
    ResolvedEntity,
    find_conflicting_sources,
    remap_relationships,
    resolve_entities,
)
from .schemas import Entity, Relationship
from .validation import OrphanEntity, StageGap, find_orphan_entities, find_stage_gaps


@dataclass
class PipelineResult:
    resolved_entities: list[ResolvedEntity]
    relationships: list[Relationship]
    stage_gaps: list[StageGap]
    orphans: list[OrphanEntity]
    ambiguous_merge_queue: list[AmbiguousMerge]
    conflicts: list[ConflictFinding]
    resolution_log: list[str]


def _namespace_ids(entities: list[Entity], relationships: list[Relationship], source_name: str) -> tuple[list[Entity], list[Relationship]]:
    """Prefix every id from one extraction call with its source file.

    The LLM invents ids independently per call and has no visibility into ids
    from other sources — two unrelated entities in different files can easily
    slugify to the same string (both call it "fce-03-temp"). Without this,
    Neo4j's MERGE-by-id would silently collapse them into one node, bypassing
    entity resolution's similarity check entirely — the merge queue and
    threshold would never even see it happen. Resolution is the only place
    ids are allowed to converge, via its explicit id_map.
    """
    local_map = {e.id: f"{source_name}::{e.id}" for e in entities}
    namespaced_entities = [e.model_copy(update={"id": local_map[e.id]}) for e in entities]
    namespaced_relationships = [
        r.model_copy(update={"from_id": local_map.get(r.from_id, r.from_id), "to_id": local_map.get(r.to_id, r.to_id)})
        for r in relationships
    ]
    return namespaced_entities, namespaced_relationships


def run_pipeline(
    project_id: str,
    source_paths: list[Path],
    store: GraphStore,
    known_merge_pairs: set[tuple[str, str]] | None = None,
    known_distinct_pairs: set[tuple[str, str]] | None = None,
    acknowledged_gap_ids: set[str] | None = None,
    acknowledged_orphan_ids: set[str] | None = None,
) -> PipelineResult:
    # Fetched once up front (not per-file) so every source in this run — including ones
    # processed earlier in this same loop — is visible as "already known" to the ones after
    # it. Without this, a signal in a data log can never be told it measures an asset that
    # only machine_list.csv defines, because each file is otherwise extracted in isolation.
    existing_entities = store.fetch_entities(project_id)
    all_entities: list[Entity] = []
    all_relationships: list[Relationship] = []

    for path in source_paths:
        parsed = parse_source(path)
        known = [
            {"id": e.id, "entity_type": e.entity_type.value, "name": e.name, "notes": e.attributes.notes}
            for e in (existing_entities + all_entities)
        ]
        result = extract_from_source(parsed.source_name, parsed.text, known_entities=known)
        entities, relationships = _namespace_ids(result.entities, result.relationships, parsed.source_name)
        all_entities.extend(entities)
        all_relationships.extend(relationships)

    resolution = resolve_entities(
        all_entities,
        existing_entities=existing_entities,
        known_merge_pairs=known_merge_pairs,
        known_distinct_pairs=known_distinct_pairs,
    )
    relationships = remap_relationships(all_relationships, resolution.id_map)

    entities_by_id = {re_.canonical.id: re_.canonical for re_ in resolution.resolved_entities}
    conflicts = find_conflicting_sources(relationships, entities_by_id)

    for re_ in resolution.resolved_entities:
        store.upsert_entity(project_id, re_.canonical)
    for r in relationships:
        store.upsert_relationship(project_id, r)

    stage_gaps = find_stage_gaps(store, project_id, acknowledged_gap_ids)
    orphans = find_orphan_entities(store, project_id, acknowledged_orphan_ids)

    return PipelineResult(
        resolved_entities=resolution.resolved_entities,
        relationships=relationships,
        stage_gaps=stage_gaps,
        orphans=orphans,
        ambiguous_merge_queue=resolution.ambiguous_merge_queue,
        conflicts=conflicts,
        resolution_log=resolution.resolution_log,
    )
