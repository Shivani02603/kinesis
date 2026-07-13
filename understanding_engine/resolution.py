"""Entity resolution — LLM-reasoned duplicate detection, human-confirmed.

Idempotent by design: pass in the project's already-confirmed entities
(`existing_entities`) and every new extraction gets resolved against that
pool too, so re-running the pipeline over the same or new sources never
creates duplicate nodes — it merges into what's already there.

Human decisions are permanent: once a pair is confirmed-same or
confirmed-distinct, it is never re-surfaced as an ambiguous question again.

Candidate duplicate pairs come from an LLM call (find_candidate_duplicate_pairs),
not embedding-cosine-similarity. Measured against real extraction output, the
embedding had no reliable separation between "same" and "different" — a
genuinely different pair (temperature vs. vibration on one machine) scored
higher than genuinely same pairs describing one signal two ways, and a real
duplicate sometimes fell out of consideration entirely because sentence
phrasing shifts slightly between LLM calls. Reasoning about manufacturing
naming conventions (a tag code like "FCE-03" abbreviating "Furnace 3") is not
something a geometric distance over two short strings can do reliably.

The only merge that ever happens without a human confirming it is an exact
name match (case/whitespace-normalized) — not a probabilistic guess at all,
just string equality.
"""

from collections import defaultdict
from dataclasses import dataclass

from .llm_extraction import find_candidate_duplicate_pairs
from .schemas import Entity, EntityType, Relationship, RelationshipType


@dataclass
class ResolvedEntity:
    canonical: Entity
    merged_from: list[str]


@dataclass
class AmbiguousMerge:
    entity_a_id: str
    entity_a_name: str
    entity_b_id: str
    entity_b_name: str
    reasoning: str


@dataclass
class ConflictFinding:
    entity_a_id: str
    entity_a_name: str
    entity_b_id: str
    entity_b_name: str
    source_asserting_a_before_b: str
    source_asserting_b_before_a: str


@dataclass
class ResolutionResult:
    resolved_entities: list[ResolvedEntity]
    id_map: dict[str, str]
    ambiguous_merge_queue: list[AmbiguousMerge]
    resolution_log: list[str]


class _UnionFind:
    def __init__(self, n: int):
        self.parent = list(range(n))

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, x: int, y: int) -> None:
        rx, ry = self.find(x), self.find(y)
        if rx != ry:
            self.parent[ry] = rx


def _pair_key(id_a: str, id_b: str) -> tuple[str, str]:
    return tuple(sorted((id_a, id_b)))


def _exact_name_match(a: Entity, b: Entity) -> bool:
    """Case/whitespace-normalized identical names — not a similarity guess at
    all, just string equality, so it is safe to auto-merge unconditionally."""
    return " ".join(a.name.split()).casefold() == " ".join(b.name.split()).casefold()


def resolve_entities(
    entities: list[Entity],
    existing_entities: list[Entity] | None = None,
    known_merge_pairs: set[tuple[str, str]] | None = None,
    known_distinct_pairs: set[tuple[str, str]] | None = None,
) -> ResolutionResult:
    existing_entities = existing_entities or []
    known_merge_pairs = known_merge_pairs or set()
    known_distinct_pairs = known_distinct_pairs or set()
    existing_ids = {e.id for e in existing_entities}

    combined = existing_entities + entities
    by_type: dict[EntityType, list[Entity]] = defaultdict(list)
    for e in combined:
        by_type[e.entity_type].append(e)

    ambiguous_queue: list[AmbiguousMerge] = []
    log: list[str] = []
    id_map: dict[str, str] = {}
    resolved: list[ResolvedEntity] = []

    for entity_type, group in by_type.items():
        by_id = {e.id: e for e in group}
        index_of = {e.id: i for i, e in enumerate(group)}
        uf = _UnionFind(len(group))
        already_paired: set[tuple[str, str]] = set()

        # Pass 1 — exact name matches, cheap and certain, no LLM needed.
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                if _exact_name_match(a, b):
                    uf.union(i, j)
                    already_paired.add(_pair_key(a.id, b.id))
                    log.append(
                        f"EXACT-NAME-MATCH [{entity_type.value}] '{a.name}' ({a.id}, src={a.source}) <-> "
                        f"'{b.name}' ({b.id}, src={b.source}) — identical name, not a similarity guess"
                    )

        # Pass 2 — LLM-reasoned candidates for everything else in this type.
        # Send one representative per Pass-1 cluster, not every raw entity: two
        # entities already unioned by an exact name match (e.g. the same column
        # name "FCE-03_TEMP" extracted separately from a tag catalog and a data
        # log) would otherwise both get compared against a third entity, asking
        # a human to confirm the same real-world merge twice over.
        representative_idx: dict[int, int] = {}
        for idx in range(len(group)):
            representative_idx.setdefault(uf.find(idx), idx)
        representatives = [group[idx] for idx in representative_idx.values()]

        candidates = find_candidate_duplicate_pairs(
            entity_type.value,
            [
                {"id": e.id, "name": e.name, "notes": e.attributes.notes, "source": e.source}
                for e in representatives
            ],
        )

        for candidate in candidates:
            if candidate.id_a not in index_of or candidate.id_b not in index_of:
                log.append(
                    f"IGNORED candidate pair referencing an unknown id: "
                    f"{candidate.id_a!r} <-> {candidate.id_b!r}"
                )
                continue
            pair = _pair_key(candidate.id_a, candidate.id_b)
            if pair in already_paired:
                continue
            a, b = by_id[candidate.id_a], by_id[candidate.id_b]

            if pair in known_merge_pairs:
                uf.union(index_of[candidate.id_a], index_of[candidate.id_b])
                log.append(
                    f"CONFIRMED-MERGE [{entity_type.value}] '{a.name}' ({a.id}) <-> "
                    f"'{b.name}' ({b.id}) — previously confirmed by human, applied without re-asking"
                )
                continue
            if pair in known_distinct_pairs:
                log.append(
                    f"CONFIRMED-DISTINCT [{entity_type.value}] '{a.name}' ({a.id}) <-> "
                    f"'{b.name}' ({b.id}) — previously rejected by human, kept separate"
                )
                continue

            ambiguous_queue.append(
                AmbiguousMerge(
                    entity_a_id=a.id,
                    entity_a_name=a.name,
                    entity_b_id=b.id,
                    entity_b_name=b.name,
                    reasoning=candidate.reasoning,
                )
            )
            log.append(
                f"AMBIGUOUS [{entity_type.value}] '{a.name}' ({a.id}, src={a.source}) <-> "
                f"'{b.name}' ({b.id}, src={b.source}) — {candidate.reasoning} — queued for human "
                "confirmation, not merged"
            )

        clusters: dict[int, list[int]] = defaultdict(list)
        for idx in range(len(group)):
            clusters[uf.find(idx)].append(idx)

        for member_indices in clusters.values():
            members = [group[i] for i in member_indices]
            existing_members = [m for m in members if m.id in existing_ids]
            if existing_members:
                # An entity already confirmed in the graph keeps its id stable across
                # runs — existing relationships already point at it.
                canonical = sorted(existing_members, key=lambda e: e.id)[0]
            else:
                canonical = max(members, key=lambda e: e.confidence)
            # Picking one member as canonical must not silently drop a useful attribute
            # another member carried — e.g. a tag catalog's entry has no source_reference,
            # but a data log's entry describing the same signal does; merging must keep it.
            # source_reference is only meaningful together with the file it names a column
            # in — a column name from one file means nothing against another file's headers
            # — so source must travel with it as one atomic pair, not be left pointing at
            # the canonical's own (different) file.
            if canonical.attributes.source_reference is None:
                donor = next((m for m in members if m.attributes.source_reference is not None), None)
                if donor is not None:
                    canonical = canonical.model_copy(
                        update={
                            "source": donor.source,
                            "attributes": canonical.attributes.model_copy(
                                update={"source_reference": donor.attributes.source_reference}
                            ),
                        }
                    )
            for m in members:
                id_map[m.id] = canonical.id
            if len(members) > 1:
                other_names = ", ".join(m.name for m in members if m.id != canonical.id)
                log.append(
                    f"RESOLVED [{entity_type.value}] canonical='{canonical.name}' "
                    f"({canonical.id}) absorbs: {other_names}"
                )
            resolved.append(ResolvedEntity(canonical=canonical, merged_from=[m.id for m in members]))

    return ResolutionResult(
        resolved_entities=resolved,
        id_map=id_map,
        ambiguous_merge_queue=ambiguous_queue,
        resolution_log=log,
    )


def remap_relationships(relationships: list[Relationship], id_map: dict[str, str]) -> list[Relationship]:
    return [
        Relationship(
            relationship_type=r.relationship_type,
            from_id=id_map.get(r.from_id, r.from_id),
            to_id=id_map.get(r.to_id, r.to_id),
            source=r.source,
        )
        for r in relationships
    ]


def find_conflicting_sources(
    relationships: list[Relationship], entities_by_id: dict[str, Entity]
) -> list[ConflictFinding]:
    """Detect two sources asserting opposite `precedes` order for the same pair.

    Pure graph comparison, no LLM — deliberately does not trust one source
    over another; both directions are surfaced together as one finding.
    """
    precedes = [r for r in relationships if r.relationship_type == RelationshipType.PRECEDES]
    direction_source: dict[tuple[str, str], str] = {(r.from_id, r.to_id): r.source for r in precedes}

    findings: list[ConflictFinding] = []
    seen_pairs: set[tuple[str, str]] = set()
    for (from_id, to_id), source in direction_source.items():
        reverse = (to_id, from_id)
        pair_key = tuple(sorted((from_id, to_id)))
        if reverse in direction_source and pair_key not in seen_pairs:
            seen_pairs.add(pair_key)
            a_name = entities_by_id[from_id].name if from_id in entities_by_id else from_id
            b_name = entities_by_id[to_id].name if to_id in entities_by_id else to_id
            findings.append(
                ConflictFinding(
                    entity_a_id=from_id,
                    entity_a_name=a_name,
                    entity_b_id=to_id,
                    entity_b_name=b_name,
                    source_asserting_a_before_b=source,
                    source_asserting_b_before_a=direction_source[reverse],
                )
            )
    return findings
