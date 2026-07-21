"""On-demand delivery-date quoting for a brand-new order that hasn't been
placed yet — a separate, derived capability layered on top of the
delivery_date objective's already-decided label, not a new objective.

Why a separate model from the regular delivery_date predictor: that model is
trained to predict what ACTUALLY happened for a real order, using every
column in the order table as a feature — including whatever column records
the promise/commitment made when the order was placed (e.g.
"promised_lead_days"). That is legitimate for judging "did we hit what we
told the customer", but circular for quoting: a brand-new hypothetical order
has no such commitment yet, since deciding it IS the question being asked.
Which column (if any) plays that role is never hardcoded — an LLM reasons
about it from the real column list and real sampled values, the same
evidence-grounded pattern as task_detection.py, verified deterministically
before use.

The quote itself carries its own honestly-computed safety margin: the model
is trained as an AutoGluon quantile regressor (not a plain point-estimate
regressor), so a single fit yields both a q50 (typical case) and a q90
(a genuinely learned "9 out of 10 similar past orders finished within this
many days") prediction — the gap between them is real historical spread,
never an invented buffer.
"""

from datetime import timedelta
from pathlib import Path

import pandas as pd
from pydantic import BaseModel

from understanding_engine.llm_extraction import _call_tool_with_retry
from .task_detection import FileCatalog
from .training import _leaderboard_records, _round, _why_model_won

_QUANTILE_LEVELS = [0.5, 0.9]

_QUOTE_PLAN_SYSTEM_PROMPT = """You are preparing a table of historical orders to train a model that will \
QUOTE a brand-new, not-yet-placed order — before any commitment to the customer has been made.

The table already has a confirmed label column (what actually happened, e.g. the real lead time in days). \
Every OTHER column is a candidate input feature. You have two jobs:

1. Identify which candidate columns, if any, record information that is only decided or known AT OR AFTER \
the moment the original order was placed — information a brand-new hypothetical order genuinely would not \
have yet, because deciding it is exactly what the quote is being asked to help with (a promised/committed \
delivery timeframe, an internal tracking or fulfillment code assigned after order creation, an \
outcome-adjacent flag set once the order was already underway). Columns describing the order ITSELF at the \
moment a customer asks for it — quantity, destination, product, whether it's a rush request — are \
genuinely knowable in advance and must NOT be excluded.

2. Identify which ONE candidate column (if any) is the order's own placement/reference date — the date \
the order was made, which combined with the predicted lead time (in days) gives a real calendar date the \
order is expected to complete. Only name a column here if the label is genuinely a day-count/duration; if \
none of the candidates is such a date, say null.

Rules:
- Go through every candidate column explicitly in your reasoning before deciding either answer — do not \
just react to column names; check the sampled values too. A column named plainly (e.g. "notes") is not \
automatically safe or automatically excluded; judge what it actually holds.
- It is entirely valid to exclude nothing — return an empty list if every column is genuinely knowable in \
advance of the order being placed.
- The reference date column (if any) is NOT automatically excluded — a new hypothetical order's own date \
is knowable (it's today, or whenever the customer is asking), it just also has this second role.
- Do not exclude the label column itself; it is not in the candidate list.
- Call the tool exactly once."""


class QuoteFeatureDecision(BaseModel):
    # reasoning first — see llm_extraction.py's field-order note; a decision
    # field declared before reasoning lets a structured-output model commit
    # to it before actually comparing the candidate columns.
    reasoning: str
    excluded_columns: list[str]
    reference_date_column: str | None = None


def identify_quote_plan(label_file_catalog: FileCatalog, label_column: str) -> QuoteFeatureDecision:
    candidates = [c for c in label_file_catalog.columns if c != label_column]
    if not candidates:
        return QuoteFeatureDecision(reasoning="No candidate feature columns exist.", excluded_columns=[])

    col_lines = "\n".join(
        f"  - {c!r}: sample values {label_file_catalog.samples.get(c, [])!r}" for c in candidates
    )
    messages: list = [
        {"role": "system", "content": _QUOTE_PLAN_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Label column (what the model predicts, a day-count): {label_column!r}\n\n"
                f"Candidate feature columns in {label_file_catalog.filename!r}:\n{col_lines}"
            ),
        },
    ]
    decision = _call_tool_with_retry(
        "record_quote_plan",
        "Record which feature columns must be excluded from a quoting model, and which column (if any) "
        "is the order's own reference date.",
        QuoteFeatureDecision,
        messages,
    )

    # Deterministic verification: a hallucinated column name is never
    # silently accepted, for either answer.
    unknown = [c for c in decision.excluded_columns if c not in candidates]
    if unknown:
        raise ValueError(
            f"quote-plan decision named excluded column(s) {unknown!r} that don't exist in "
            f"{label_file_catalog.filename!r} — cannot proceed on a hallucinated column"
        )
    if decision.reference_date_column is not None and decision.reference_date_column not in candidates:
        raise ValueError(
            f"quote-plan decision named reference_date_column {decision.reference_date_column!r} that "
            f"doesn't exist in {label_file_catalog.filename!r} — cannot proceed on a hallucinated column"
        )
    return decision


def train_quote_model(
    upload_dir: Path,
    label_file: str,
    label_column: str,
    label_file_catalog: FileCatalog,
    model_dir: Path,
    time_limit: int = 300,
) -> dict:
    from autogluon.tabular import TabularPredictor

    table = pd.read_csv(upload_dir / label_file)
    if label_column not in table.columns:
        raise ValueError(f"label column {label_column!r} not found in {label_file!r}")

    plan = identify_quote_plan(label_file_catalog, label_column)
    excluded_columns = plan.excluded_columns
    feature_columns = [c for c in table.columns if c != label_column and c not in excluded_columns]
    if len(feature_columns) < 1:
        raise ValueError(
            f"after excluding {excluded_columns!r}, no feature columns remain in {label_file!r} — "
            "cannot train a quoting model with nothing knowable in advance to learn from"
        )
    # The reference date is used for date arithmetic after prediction, not
    # as a raw model feature — a free-text date string add no real signal to
    # a tree model beyond what its own month/day-of-week components already
    # give it, and keeping it out of the trained feature set keeps the
    # meaning of feature_columns (below) exactly "what the quote form asks
    # for" simple and unambiguous.
    reference_date_column = plan.reference_date_column
    if reference_date_column is not None and reference_date_column in feature_columns:
        feature_columns = [c for c in feature_columns if c != reference_date_column]

    train_table = table[table[label_column].notna()].reset_index(drop=True)
    if train_table.empty:
        raise ValueError(f"{label_file!r} has no completed rows (label {label_column!r} always blank)")
    quote_table = train_table[feature_columns + [label_column]]

    predictor = TabularPredictor(
        label=label_column, problem_type="quantile", quantile_levels=_QUANTILE_LEVELS,
        path=str(model_dir), verbosity=0,
    )
    predictor.fit(quote_table, presets="medium_quality", time_limit=time_limit)
    leaderboard = predictor.leaderboard()
    leaderboard_records = _leaderboard_records(leaderboard)

    return {
        "task_type": "delivery_quote",
        "best_model": predictor.model_best,
        "leaderboard": leaderboard_records,
        "why_model_won": _why_model_won(leaderboard_records, predictor.model_best),
        "params": {
            "label_file": label_file,
            "label_column": label_column,
            "feature_columns": feature_columns,
            "excluded_columns": excluded_columns,
            "reference_date_column": reference_date_column,
            "quantile_levels": _QUANTILE_LEVELS,
            "training_rows": len(quote_table),
            "time_limit_seconds": time_limit,
        },
    }


def predict_quote(
    model_dir: Path, feature_columns: list[str], reference_date_column: str | None, inputs: dict
) -> dict:
    """inputs: raw {column_name: value} straight from the quote form — the
    form itself is built by the caller from feature_columns (+ the reference
    date field, if any), so this is never a hardcoded field set."""
    from autogluon.tabular import TabularPredictor

    missing = [c for c in feature_columns if c not in inputs]
    if missing:
        raise ValueError(f"missing required field(s) for a quote: {missing!r}")

    predictor = TabularPredictor.load(str(model_dir))
    row = pd.DataFrame([{c: inputs[c] for c in feature_columns}])
    pred = predictor.predict(row)

    q50 = _round(float(pred[0.5].iloc[0]))
    q90 = _round(float(pred[0.9].iloc[0]))
    result = {
        "typical_days": q50,
        "suggested_promise_days": q90,
        "quantile_levels": _QUANTILE_LEVELS,
    }

    if reference_date_column is not None:
        raw = inputs.get(reference_date_column)
        if raw:
            # dayfirst=False here: the frontend renders this specific field as
            # an HTML date input, which always submits ISO YYYY-MM-DD
            # regardless of the visitor's locale display — no ambiguity to
            # resolve.
            ref_date = pd.to_datetime(raw, errors="coerce")
            if pd.notna(ref_date):
                result["reference_date"] = ref_date.date().isoformat()
                result["typical_date"] = (ref_date + timedelta(days=q50)).date().isoformat()
                result["suggested_promise_date"] = (ref_date + timedelta(days=q90)).date().isoformat()

    return result
