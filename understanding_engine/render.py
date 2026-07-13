"""Builds the Layer 2 output: a plain-text + JSON report for human review.

Per the brief's scope note, this is a printout, not a graph visualization UI —
building an interactive viewer is explicitly a separate, later task.
"""

import json
from dataclasses import asdict
from pathlib import Path

from .resolution import AmbiguousMerge, ConflictFinding, ResolvedEntity
from .schemas import Relationship
from .validation import OrphanEntity, StageGap


def build_report(
    resolved_entities: list[ResolvedEntity],
    relationships: list[Relationship],
    stage_gaps: list[StageGap],
    orphans: list[OrphanEntity],
    ambiguous_queue: list[AmbiguousMerge],
    conflicts: list[ConflictFinding],
    resolution_log: list[str],
) -> tuple[str, dict]:
    lines: list[str] = []

    lines.append("=" * 72)
    lines.append("LAYER 2 -- UNDERSTANDING LAYER REPORT (pre-confirmation)")
    lines.append("=" * 72)

    lines.append("")
    lines.append(f"RESOLVED ENTITIES ({len(resolved_entities)})")
    lines.append("-" * 72)
    by_type: dict[str, list[ResolvedEntity]] = {}
    for re_ in resolved_entities:
        by_type.setdefault(re_.canonical.entity_type.value, []).append(re_)
    for entity_type, group in sorted(by_type.items()):
        lines.append(f"\n[{entity_type}]")
        for re_ in group:
            c = re_.canonical
            merged_note = (
                f"  (merged from: {', '.join(re_.merged_from)})" if len(re_.merged_from) > 1 else ""
            )
            perspective = (
                f" perspective={c.attributes.perspective.value}" if c.attributes.perspective else ""
            )
            lines.append(
                f"  - {c.id}: {c.name}{perspective} "
                f"[source={c.source}, confidence={c.confidence:.2f}]{merged_note}"
            )

    lines.append("")
    lines.append(f"RELATIONSHIPS ({len(relationships)})")
    lines.append("-" * 72)
    for r in relationships:
        lines.append(f"  - {r.from_id} --{r.relationship_type.value}--> {r.to_id}  [source={r.source}]")

    lines.append("")
    lines.append(
        f"STAGE GAP CANDIDATES ({len(stage_gaps)}) -- human judgment needed: "
        "legitimate start/end vs. real gap"
    )
    lines.append("-" * 72)
    if not stage_gaps:
        lines.append("  (none)")
    for g in stage_gaps:
        lines.append(f"  - {g.stage_name} ({g.stage_id}): missing {g.missing}")

    lines.append("")
    lines.append(f"ORPHAN ENTITIES ({len(orphans)}) -- no relationships at all")
    lines.append("-" * 72)
    if not orphans:
        lines.append("  (none)")
    for o in orphans:
        lines.append(f"  - {o.entity_name} ({o.entity_id}) [{o.entity_label}]")

    lines.append("")
    lines.append(
        f"AMBIGUOUS MERGE QUEUE ({len(ambiguous_queue)}) -- human confirmation needed (naming question)"
    )
    lines.append("-" * 72)
    if not ambiguous_queue:
        lines.append("  (none)")
    for m in ambiguous_queue:
        lines.append(
            f"  - '{m.entity_a_name}' ({m.entity_a_id}) <-> '{m.entity_b_name}' ({m.entity_b_id}) "
            f"similarity={m.similarity:.3f}"
        )

    lines.append("")
    lines.append(
        f"CONFLICTING SOURCE FINDINGS ({len(conflicts)}) -- human input needed (order question)"
    )
    lines.append("-" * 72)
    if not conflicts:
        lines.append("  (none)")
    for c in conflicts:
        lines.append(
            f"  - '{c.entity_a_name}' vs '{c.entity_b_name}': "
            f"{c.source_asserting_a_before_b} says the former precedes the latter, "
            f"{c.source_asserting_b_before_a} asserts the opposite order"
        )

    lines.append("")
    lines.append(f"RESOLUTION DECISION LOG ({len(resolution_log)})")
    lines.append("-" * 72)
    for entry in resolution_log:
        lines.append(f"  - {entry}")

    text = "\n".join(lines)

    data = {
        "entities": [
            {
                "id": re_.canonical.id,
                "entity_type": re_.canonical.entity_type.value,
                "name": re_.canonical.name,
                "perspective": (
                    re_.canonical.attributes.perspective.value
                    if re_.canonical.attributes.perspective
                    else None
                ),
                "notes": re_.canonical.attributes.notes,
                "source": re_.canonical.source,
                "confidence": re_.canonical.confidence,
                "merged_from": re_.merged_from,
            }
            for re_ in resolved_entities
        ],
        "relationships": [
            {
                "relationship_type": r.relationship_type.value,
                "from_id": r.from_id,
                "to_id": r.to_id,
                "source": r.source,
            }
            for r in relationships
        ],
        "stage_gaps": [asdict(g) for g in stage_gaps],
        "orphans": [asdict(o) for o in orphans],
        "ambiguous_merge_queue": [asdict(m) for m in ambiguous_queue],
        "conflicting_source_findings": [asdict(c) for c in conflicts],
        "resolution_log": resolution_log,
    }

    return text, data


def write_report(data: dict, json_path: Path) -> None:
    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
