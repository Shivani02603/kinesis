"""Feasibility Engine (B) — a cheap pre-filter, never a training step.

Generalized across objectives, not one hardcoded function per objective:

1. Structural + data-presence — does the confirmed graph contain a Signal
   whose source_reference names a file/column that actually holds recorded
   values? This is a deterministic graph/data fact, identical no matter what
   the objective is — a pure Cypher query and a row count, instant, no
   training. An asset link (Signal-MEASURES->Asset) is carried along as
   context when it exists but is deliberately NOT required: a machine's
   sensor reading measures an asset, but delivery/demand/inventory evidence
   lives in business event tables (orders, shipments) whose columns are
   attributes of an event, not measurements of a machine — requiring an
   asset link would structurally blind those objectives to their own data.
2. Relevance — of the signals structural checking found, which ones are
   actually evidence for THIS objective? That is a semantic judgment (a
   temperature reading is evidence for "machine failure risk" but not for
   "quality/defect rate"), so it goes to the LLM — grounded in each signal's
   real name/notes, never a keyword match — with a deterministic verification
   pass afterward: any signal id the LLM names must exist in the candidate
   list it was given, or the verdict is rejected as unverifiable rather than
   silently trusted.

A "yes" verdict here means "worth attempting" — never "will work." Whether
there is ENOUGH relevant data for a reliable model is the Computation
Engine's job to determine empirically, not this check's.
"""

import csv
from dataclasses import dataclass, field
from pathlib import Path

from pydantic import BaseModel

from .graph_store import GraphStore
from .llm_extraction import _call_tool_with_retry

_RELEVANCE_SYSTEM_PROMPT = """You are deciding which recorded signals from a factory's confirmed \
process graph are relevant evidence for a specific business objective. You will see every signal \
that has real recorded values on file. Some measure a physical asset (sensor readings); others are \
columns of a business/event table (orders, shipments, inspections) and are not linked to any asset \
— both kinds are equally legitimate evidence, for different objectives.

Rules:
- Judge relevance from what each signal actually records (its name, its notes, and the asset it \
measures if any) — not by matching words in the objective to words in the signal name.
- A signal is relevant only if it could plausibly help answer the objective. Example: a temperature \
or vibration reading is relevant to "machine failure risk" but not to "quality/defect rate"; a \
reject or scrap rate is relevant to "quality/defect rate" but not to "machine failure risk". The \
same signal can be relevant to more than one objective if it genuinely applies to both.
- It is completely fine for zero signals to be relevant — say so honestly in your reasoning rather \
than forcing a match that isn't really there.
- Only list signal ids that appear in the list given to you below.
- Call the tool exactly once."""


class RelevanceDecision(BaseModel):
    # reasoning MUST come first: structured-output models fill fields in the
    # order they're declared, so if the id list were declared first the model
    # would commit to it before "thinking out loud" in reasoning — we saw this
    # exact failure live (reasoning concluding a signal IS relevant while the
    # id list stayed empty, because the list had already been generated).
    # Reasoning first means the final list reflects the conclusion, not a
    # premature guess the reasoning then contradicts.
    reasoning: str
    relevant_signal_ids: list[str]


@dataclass
class SignalDataSummary:
    signal_id: str
    signal_name: str
    asset_name: str | None  # None for business-event columns not linked to any asset
    source_file: str
    source_column: str
    row_count: int


@dataclass
class FeasibilityVerdict:
    objective: str
    attemptable: bool
    reason: str
    supporting_signals: list[SignalDataSummary] = field(default_factory=list)


def _count_column_values(file_path: Path, column: str) -> int | None:
    """How many non-empty values a column actually has. Returns None if the
    file or column doesn't exist (nothing to count), never guesses a number."""
    if not file_path.exists() or file_path.suffix.lower() != ".csv":
        return None
    with open(file_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        if column not in (reader.fieldnames or []):
            return None
        return sum(1 for row in reader if (row.get(column) or "").strip())


def _find_signals_with_data(store: GraphStore, project_id: str, upload_dir: Path) -> list[dict]:
    """Every Signal with real recorded values on file — the objective-agnostic
    structural + data-presence half of feasibility. The asset it measures is
    attached as context when that link exists; a business-event column
    (order lead time, shipped units) legitimately has none."""
    signals = store.signals_with_data_reference(project_id)
    found = []
    for row in signals:
        count = _count_column_values(upload_dir / row["source_file"], row["source_column"])
        if count:
            found.append({**row, "row_count": count})
    return found


def _judge_relevance(objective: str, candidates: list[dict]) -> RelevanceDecision:
    listing = "\n".join(
        f"- id={c['signal_id']!r}, name={c['signal_name']!r}, notes={c['signal_notes']!r}, "
        + (
            f"measures asset {c['asset_name']!r}"
            if c["asset_name"]
            else f"not linked to any asset (column of business/event table {c['source_file']!r})"
        )
        + f", {c['row_count']} real recorded values on file"
        for c in candidates
    )
    messages: list = [
        {"role": "system", "content": _RELEVANCE_SYSTEM_PROMPT},
        {"role": "user", "content": f"Objective: {objective}\n\nMeasured signals with real data:\n{listing}"},
    ]
    decision = _call_tool_with_retry(
        "record_relevance",
        "Record which of the given signals are relevant evidence for this objective.",
        RelevanceDecision,
        messages,
    )

    candidate_ids = {c["signal_id"] for c in candidates}
    unknown = [sid for sid in decision.relevant_signal_ids if sid not in candidate_ids]
    if unknown:
        raise ValueError(
            f"relevance judgment named signal id(s) not in the candidate list it was given: "
            f"{unknown!r} — refusing to trust an unverifiable claim"
        )
    return decision  # type: ignore[return-value]


def check_feasibility(objective: str, store: GraphStore, project_id: str, upload_dir: Path) -> FeasibilityVerdict:
    candidates = _find_signals_with_data(store, project_id, upload_dir)

    if not candidates:
        return FeasibilityVerdict(
            objective=objective,
            attemptable=False,
            reason="No signal in the confirmed graph has any real recorded values on file — "
            "there is nothing to build on yet.",
        )

    decision = _judge_relevance(objective, candidates)
    by_id = {c["signal_id"]: c for c in candidates}
    relevant = [by_id[sid] for sid in decision.relevant_signal_ids]

    if not relevant:
        return FeasibilityVerdict(
            objective=objective,
            attemptable=False,
            reason=f"{len(candidates)} signal(s) have real recorded readings, but none are relevant "
            f"evidence for '{objective}': {decision.reasoning}",
        )

    return FeasibilityVerdict(
        objective=objective,
        attemptable=True,
        reason=f"{len(relevant)} signal(s) relevant to '{objective}' have real recorded readings — "
        f"worth attempting. {decision.reasoning} Whether there is enough of it for a reliable model "
        "is for the Computation Engine to determine empirically, not this check.",
        supporting_signals=[
            SignalDataSummary(
                signal_id=c["signal_id"],
                signal_name=c["signal_name"],
                asset_name=c["asset_name"],
                source_file=c["source_file"],
                source_column=c["source_column"],
                row_count=c["row_count"],
            )
            for c in relevant
        ],
    )
