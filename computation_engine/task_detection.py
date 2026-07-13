"""Which kind of model does the available data genuinely support?

The branch itself is the design the user chose: if recorded failure/outcome
labels exist, train a supervised model on them; if only sensor readings exist,
train a probabilistic forecaster whose own quantile bands become the
"normal range" — a boundary learned from this machine's history, never a
number we picked.

Whether a column IS a recorded outcome label is a semantic judgment, so it
goes to the LLM — with deterministic facts (real headers, real sampled
values) as evidence, and a deterministic verification afterwards: if the LLM
names a label column that doesn't actually exist or holds no values, that is
an error surfaced to the human, never a silent fall-through to forecasting.
"""

import csv
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from pydantic import BaseModel

from understanding_engine.llm_extraction import _call_tool_with_retry

_SAMPLE_VALUES_PER_COLUMN = 5

_TASK_SYSTEM_PROMPT = """You are deciding what kind of model training a factory's uploaded data \
genuinely supports, for a given business objective. You will see every uploaded tabular file's \
real column headers with a few real sampled values per column, plus the signals the confirmed \
process graph says measure assets.

Three task types exist:
- "supervised": ONLY if some file has rows keyed to discrete entities or events (a unit, an order, \
an inspection, a failure incident) with real OTHER feature columns alongside a recorded outcome \
column for that same row (e.g. process parameters plus a pass/fail result per unit; conditions \
plus a failure occurrence per incident). If you choose this, name the exact file and column \
holding the label.
- "forecasting": every other predictive case, INCLUDING a business metric that sounds like an \
"outcome" (a reject rate, a scrap percentage, a downtime minutes count) if it is simply sampled \
repeatedly over time with nothing but a timestamp alongside it. A single continuous value with \
only a time axis is a time series regardless of what it measures or how important it is to the \
objective — model its own behavior over time, the same as a sensor reading. Do not call something \
"supervised" just because its name sounds like a quality/business outcome; what matters is whether \
the row carries real predictive features beside the timestamp, not what the metric represents. \
This is the CORRECT and INTENDED choice — not a fallback or a lesser substitute — for monitoring-style \
objectives (equipment condition/failure-risk monitoring, quality/defect-rate monitoring, demand or \
consumption levels) whenever no genuine labeled-outcome table exists: learning a signal's own normal \
range and flagging deviation from it IS how those objectives get answered without failure/inspection \
labels. Do not reason your way to "not_supportable" for such an objective just because forecasting \
"isn't really predicting the outcome" — for these objectives, forecasting the relevant signal(s) \
always satisfies the objective when no labeled data exists.
- "scheduling": the objective is not a prediction at all but a PLANNING decision — deciding when \
which job/order runs on which machine, given pending work and capacity. Choose this only when the \
objective asks for a plan/schedule/sequencing AND the data contains both (a) a table of pending \
discrete jobs or orders with quantities and due dates that have not yet happened, and (b) capacity \
information such as a routing sheet with machine processing rates/sequence.
- "not_supportable": what the objective asks for genuinely cannot be produced from this data by \
ANY of the above. The most important case: the objective asks for a plan/schedule but the \
pending-orders table or the routing/capacity table is missing — then a schedule cannot be \
computed, and quietly substituting some other prediction that the data happens to support would \
answer a question nobody asked. Say exactly what is missing in reasoning; the user reads it \
verbatim and can upload the missing data. An honest "cannot do this yet, here is what is needed" \
is always better than a confident wrong deliverable.

Rules:
- Judge from the actual sampled values and the full column list, not column names alone.
- A file with only [timestamp, value] columns can NEVER be the supervised label file — there is \
nothing for a supervised model to learn from besides the timestamp, which is exactly what \
forecasting already models properly. If that is the only quality/outcome-sounding column you can \
find, the honest choice is forecasting.
- Do not invent a label that is not there. Choosing "supervised" without genuine other feature \
columns would force the pipeline into a model with nothing to actually learn from.
- If you choose supervised, also state what KIND of outcome the label is:
  - "quantity": a measured/counted amount where distance matters — days of lead time, a duration, \
a cost, a count. Being off by 1 is much better than off by 10, so it must be modeled as \
regression. A quantity stays a quantity even when its recorded values happen to be a few small \
integers.
  - "category": a discrete state where there is no meaningful "distance" between values — \
pass/fail, failure mode, defect type.
- Explain your decision in reasoning — a human reads it verbatim in the UI.
- Call the tool exactly once."""


class TaskDecision(BaseModel):
    # reasoning first: a structured-output model fills fields in declaration
    # order, so the decision fields must come after the reasoning that leads
    # to them, not before — see the identical, observed bug in
    # feasibility.RelevanceDecision for why this ordering is load-bearing.
    reasoning: str
    task_type: Literal["supervised", "forecasting", "scheduling", "not_supportable"]
    label_file: str | None = None
    label_column: str | None = None
    label_kind: Literal["quantity", "category"] | None = None


@dataclass
class FileCatalog:
    filename: str
    columns: list[str]
    row_count: int
    samples: dict[str, list[str]]


def build_file_catalog(upload_dir: Path) -> list[FileCatalog]:
    """Deterministic facts about every uploaded CSV: headers, row count, and
    the first few non-empty values per column. No interpretation here."""
    catalogs = []
    for path in sorted(upload_dir.glob("*.csv")):
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            columns = list(reader.fieldnames or [])
            samples: dict[str, list[str]] = {c: [] for c in columns}
            row_count = 0
            for row in reader:
                row_count += 1
                for c in columns:
                    value = (row.get(c) or "").strip()
                    if value and len(samples[c]) < _SAMPLE_VALUES_PER_COLUMN:
                        samples[c].append(value)
        catalogs.append(FileCatalog(filename=path.name, columns=columns, row_count=row_count, samples=samples))
    return catalogs


def detect_task(objective: str, supporting_signals: list[dict], catalogs: list[FileCatalog]) -> TaskDecision:
    """supporting_signals: the Feasibility verdict's signal summaries
    (signal_name, asset_name, source_file, source_column, row_count)."""
    signal_lines = "\n".join(
        f"- signal {s['signal_name']!r} "
        + (f"measures asset {s['asset_name']!r}" if s.get("asset_name") else "(business/event data, no asset link)")
        + f"; its values are column {s['source_column']!r} in {s['source_file']!r} ({s['row_count']} readings)"
        for s in supporting_signals
    )
    file_blocks = []
    for cat in catalogs:
        col_lines = "\n".join(
            f"    - {c!r}: sample values {cat.samples[c]!r}" for c in cat.columns
        )
        file_blocks.append(f"  file {cat.filename!r} ({cat.row_count} rows):\n{col_lines}")
    file_listing = "\n".join(file_blocks)

    messages: list = [
        {"role": "system", "content": _TASK_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Business objective: {objective}\n\n"
                f"Signals the confirmed graph links to assets:\n{signal_lines}\n\n"
                f"All uploaded tabular files:\n{file_listing}"
            ),
        },
    ]
    decision = _call_tool_with_retry(
        "record_task_decision",
        "Record which task type the available data supports for this objective.",
        TaskDecision,
        messages,
    )

    if decision.task_type == "supervised":
        catalog_by_name = {c.filename: c for c in catalogs}
        cat = catalog_by_name.get(decision.label_file or "")
        if cat is None:
            raise ValueError(
                f"task detection chose supervised with label file {decision.label_file!r}, "
                "but no such uploaded file exists — cannot proceed on a label that isn't there"
            )
        if decision.label_column not in cat.columns:
            raise ValueError(
                f"task detection chose supervised with label column {decision.label_column!r}, "
                f"but {decision.label_file!r} has no such column — cannot proceed"
            )
        if not cat.samples.get(decision.label_column):
            raise ValueError(
                f"label column {decision.label_column!r} in {decision.label_file!r} holds no "
                "values — cannot train a supervised model on an empty label"
            )
        if decision.label_kind is None:
            raise ValueError(
                "task detection chose supervised but did not state whether the label is a "
                "quantity or a category — the two are modeled fundamentally differently and "
                "this cannot be guessed"
            )
        if decision.label_kind == "quantity":
            unparseable = [
                v for v in cat.samples[decision.label_column]
                if not v.replace(".", "", 1).replace("-", "", 1).isdigit()
            ]
            if unparseable:
                raise ValueError(
                    f"task detection called label {decision.label_column!r} a quantity, but its "
                    f"sampled values include non-numeric entries {unparseable!r} — a quantity "
                    "must be numeric; this contradiction needs human review"
                )
        feature_columns = [c for c in cat.columns if c != decision.label_column]
        if len(feature_columns) < 2:
            # A file with only a timestamp (or a single id column) beside the label has nothing
            # for a supervised model to learn from — that is a single time series wearing a label's
            # clothing, not evidence of discrete per-row features. Reject regardless of what the
            # LLM's reasoning claimed; this is a structural fact, not a judgment call.
            raise ValueError(
                f"task detection chose supervised on {decision.label_file!r} / "
                f"{decision.label_column!r}, but that file has only {feature_columns!r} besides the "
                "label — no real predictive features, so this is actually a single time series, "
                "not a supervised learning case. Refusing to train a model with nothing to learn from."
            )
    return decision  # type: ignore[return-value]
