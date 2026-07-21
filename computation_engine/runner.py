"""Orchestrates one training/optimization run: detect task type -> assemble
data -> train or solve.

Pure engine function like understanding_engine.pipeline — knows nothing about
HTTP or SQLite. The API layer persists what this returns.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .data_assembly import assemble_forecasting_frame, load_labeled_table
from .task_detection import build_file_catalog, detect_task
from .training import train_forecasting, train_supervised

if TYPE_CHECKING:
    from scheduling_engine.solver import GraphMaintenanceContext


class ObjectiveNotSupported(Exception):
    """A clean, honest 'this objective can't be attempted with the current data'
    verdict — NOT an error. Raised instead of a bare ValueError so the API layer
    can mark the run 'not applicable' (a normal, expected outcome) rather than
    'failed' (which reads as something broke). The message is still shown verbatim."""


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
    time_limit: int | None = 600,
    settings: dict[str, str] | None = None,
    graph_context: "GraphMaintenanceContext | None" = None,
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
        raise ObjectiveNotSupported(
            f"This objective can't be attempted with the current data: it doesn't ask for a "
            f"production schedule, and the only thing the data supports here is scheduling. {decision.reasoning}"
        )

    if decision.task_type == "not_supportable":
        # A clean 'can't do this yet, upload X' — an honest verdict, not a crash.
        raise ObjectiveNotSupported(f"This objective isn't supportable with the current data. {decision.reasoning}")

    if decision.task_type == "scheduling":
        # Not training at all — an exact CP-SAT optimization; imported lazily so the
        # predictive paths never pay for OR-Tools.
        from scheduling_engine.solver import run_scheduling

        result, inputs_reasoning = run_scheduling(catalogs, upload_dir, settings, graph_context)
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
        # Recorded so a later, separate step (on-demand order quoting) can
        # reuse this already-verified label file/column instead of re-asking
        # the same question — purely additive, nothing reads this dict
        # expecting a fixed key set.
        result["params"]["label_file"] = decision.label_file
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
