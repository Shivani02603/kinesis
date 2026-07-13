"""Orchestrates one training/optimization run: detect task type -> assemble
data -> train or solve.

Pure engine function like understanding_engine.pipeline — knows nothing about
HTTP or SQLite. The API layer persists what this returns.
"""

from dataclasses import dataclass
from pathlib import Path

from .data_assembly import assemble_forecasting_frame, load_labeled_table
from .task_detection import build_file_catalog, detect_task
from .training import train_forecasting, train_supervised


@dataclass
class TrainingRunResult:
    task_type: str
    decision_reasoning: str
    result: dict  # leaderboard, series/feature_importance/schedule, params — JSON-ready


def run_training(
    objective: str,
    supporting_signals: list[dict],
    upload_dir: Path,
    model_dir: Path,
    time_limit: int = 600,
) -> TrainingRunResult:
    catalogs = build_file_catalog(upload_dir)
    decision = detect_task(objective, supporting_signals, catalogs)

    if decision.task_type == "scheduling" and objective != "scheduling":
        # A structural fact, checked regardless of what the model reasoned: "scheduling"
        # is a valid answer only for the one objective that actually asks for a
        # production plan. Seeing scheduling-shaped data (open orders + routing) sitting
        # in the same project is not evidence that THIS objective wants a schedule —
        # e.g. "inventory" asks about material replenishment, not sequencing jobs, even
        # though both may share an upload folder. Never silently substitute the wrong
        # deliverable just because the data happened to support computing something.
        raise ValueError(
            f"Task detection chose 'scheduling' for the '{objective}' objective, but scheduling "
            "is only a valid answer for the scheduling objective itself — this looks like the "
            "model reasoning from what the data supports rather than what was actually asked. "
            f"Reasoning was: {decision.reasoning}"
        )

    if decision.task_type == "not_supportable":
        # Surfaced as a failed run whose error text the user reads verbatim —
        # an honest "cannot do this yet, upload X" instead of quietly training
        # some other model the data happens to support.
        raise ValueError(f"This objective is not supportable with the current data. {decision.reasoning}")

    if decision.task_type == "scheduling":
        # Not training at all — an exact CP-SAT optimization; imported lazily so the
        # predictive paths never pay for OR-Tools.
        from scheduling_engine.solver import run_scheduling

        result, inputs_reasoning = run_scheduling(catalogs, upload_dir)
        return TrainingRunResult(
            task_type="scheduling",
            decision_reasoning=f"{decision.reasoning}\n\nInput identification: {inputs_reasoning}",
            result=result,
        )

    if decision.task_type == "supervised":
        table = load_labeled_table(upload_dir, decision.label_file)
        result = train_supervised(
            table, decision.label_column, decision.label_kind, model_dir, time_limit=time_limit
        )
    else:
        assembled = assemble_forecasting_frame(upload_dir, supporting_signals)
        result = train_forecasting(assembled, model_dir, time_limit=time_limit)
        result["params"]["timestamp_columns"] = assembled.timestamp_columns
        result["params"]["rows_per_signal"] = assembled.per_signal_rows
        if assembled.excluded_signals:
            result["params"]["excluded_signals"] = assembled.excluded_signals

    return TrainingRunResult(
        task_type=decision.task_type,
        decision_reasoning=decision.reasoning,
        result=result,
    )
