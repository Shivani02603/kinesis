"""Identify scheduling inputs (LLM + deterministic verification), then solve
the flow-shop schedule exactly with CP-SAT.

Model: every order passes through every routing step in routing-sequence
order; each machine runs one order at a time; duration of a step is
quantity / rate (rounded up to whole hours). Objective: minimize total
tardiness first (hours late past due dates), then makespan as a tiebreaker.
This is exact optimization — the solver proves optimality for problems this
size, so the schedule is not a heuristic guess.
"""

import math
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal

import pandas as pd
from pydantic import BaseModel

from computation_engine.task_detection import FileCatalog
from understanding_engine.llm_extraction import _call_tool_with_retry

_INPUTS_SYSTEM_PROMPT = """You are identifying which uploaded tables hold the inputs a production \
schedule needs, and which column is which. You will see every uploaded CSV's real headers and \
sampled values.

Required inputs:
- The OPEN ORDERS table: one row per pending job/order, with an order identifier column, a \
quantity column (how many units to produce), and a due-date column.
- The ROUTING table: one row per processing step, with a machine/work-center name column, a \
processing-rate column (units per hour), and a step-sequence column (the order steps run in).

Rules:
- Judge from the actual sampled values, not column names alone.
- A table of HISTORICAL orders that already have recorded outcomes (e.g. an actual lead time \
already measured) is history, not open orders — do not pick it as the open-orders table if a \
genuinely pending-orders table also exists.
- If a required table or column genuinely is not present, set it to null and say so in reasoning \
— an honest "cannot schedule, missing X" beats a wrong guess.
- Call the tool exactly once."""


class SchedulingInputs(BaseModel):
    # reasoning first — same field-order fix as feasibility.RelevanceDecision
    # and task_detection.TaskDecision: a structured-output model commits to
    # fields in declaration order, so the identification fields must follow
    # the reasoning that produces them.
    reasoning: str
    orders_file: str | None
    order_id_column: str | None
    quantity_column: str | None
    due_date_column: str | None
    routing_file: str | None
    machine_column: str | None
    rate_column: str | None
    sequence_column: str | None


class _VerifiedInputs(BaseModel):
    orders: list[dict]
    routing: list[dict]
    reasoning: str


def identify_inputs(catalogs: list[FileCatalog], upload_dir: Path) -> _VerifiedInputs:
    file_blocks = []
    for cat in catalogs:
        col_lines = "\n".join(f"    - {c!r}: sample values {cat.samples[c]!r}" for c in cat.columns)
        file_blocks.append(f"  file {cat.filename!r} ({cat.row_count} rows):\n{col_lines}")

    messages: list = [
        {"role": "system", "content": _INPUTS_SYSTEM_PROMPT},
        {"role": "user", "content": "Uploaded tables:\n" + "\n".join(file_blocks)},
    ]
    decision: SchedulingInputs = _call_tool_with_retry(
        "record_scheduling_inputs",
        "Record which tables/columns hold the open orders and the routing information.",
        SchedulingInputs,
        messages,
    )  # type: ignore[assignment]

    missing = [
        name
        for name, value in [
            ("open-orders table", decision.orders_file),
            ("order id column", decision.order_id_column),
            ("quantity column", decision.quantity_column),
            ("due-date column", decision.due_date_column),
            ("routing table", decision.routing_file),
            ("machine column", decision.machine_column),
            ("rate column", decision.rate_column),
            ("sequence column", decision.sequence_column),
        ]
        if not value
    ]
    if missing:
        raise ValueError(
            f"cannot schedule — required input(s) not found in the uploaded data: {', '.join(missing)}. "
            f"Reasoning: {decision.reasoning}"
        )

    orders_df = pd.read_csv(upload_dir / decision.orders_file)
    routing_df = pd.read_csv(upload_dir / decision.routing_file)

    for df, cols, fname in (
        (orders_df, [decision.order_id_column, decision.quantity_column, decision.due_date_column], decision.orders_file),
        (routing_df, [decision.machine_column, decision.rate_column, decision.sequence_column], decision.routing_file),
    ):
        for col in cols:
            if col not in df.columns:
                raise ValueError(f"identified column {col!r} does not exist in {fname!r} — unverifiable, refusing to guess")

    quantities = pd.to_numeric(orders_df[decision.quantity_column], errors="coerce")
    if quantities.isna().any() or (quantities <= 0).any():
        raise ValueError(f"quantity column {decision.quantity_column!r} has non-numeric or non-positive values")
    due_dates = pd.to_datetime(orders_df[decision.due_date_column], errors="coerce", format="mixed")
    if due_dates.isna().any():
        raise ValueError(f"due-date column {decision.due_date_column!r} has values that do not parse as dates")
    rates = pd.to_numeric(routing_df[decision.rate_column], errors="coerce")
    if rates.isna().any() or (rates <= 0).any():
        raise ValueError(f"rate column {decision.rate_column!r} has non-numeric or non-positive values")
    sequences = pd.to_numeric(routing_df[decision.sequence_column], errors="coerce")
    if sequences.isna().any() or sequences.duplicated().any():
        raise ValueError(f"sequence column {decision.sequence_column!r} must be unique numbers — got {list(routing_df[decision.sequence_column])!r}")

    orders = [
        {"order_id": str(row[decision.order_id_column]), "quantity": int(q), "due_date": d.to_pydatetime()}
        for (_, row), q, d in zip(orders_df.iterrows(), quantities, due_dates)
    ]
    routing = sorted(
        (
            {"machine": str(row[decision.machine_column]), "rate": float(r), "sequence": int(s)}
            for (_, row), r, s in zip(routing_df.iterrows(), rates, sequences)
        ),
        key=lambda step: step["sequence"],
    )
    return _VerifiedInputs(orders=orders, routing=routing, reasoning=decision.reasoning)


def solve_schedule(inputs: _VerifiedInputs, schedule_start: datetime | None = None) -> dict:
    from ortools.sat.python import cp_model

    orders = inputs.orders
    routing = inputs.routing
    # The schedule starts now (rounded up to the next full hour): planning the past
    # would be meaningless, and every due date is measured against this same origin.
    start = schedule_start or datetime.now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

    durations = [
        [max(1, math.ceil(o["quantity"] / step["rate"])) for step in routing]
        for o in orders
    ]
    horizon = sum(sum(d) for d in durations)

    model = cp_model.CpModel()
    starts, ends, intervals = {}, {}, {}
    for i, o in enumerate(orders):
        for j, _step in enumerate(routing):
            starts[i, j] = model.new_int_var(0, horizon, f"s_{i}_{j}")
            ends[i, j] = model.new_int_var(0, horizon, f"e_{i}_{j}")
            intervals[i, j] = model.new_interval_var(starts[i, j], durations[i][j], ends[i, j], f"iv_{i}_{j}")
            if j > 0:
                model.add(starts[i, j] >= ends[i, j - 1])

    for j in range(len(routing)):
        model.add_no_overlap([intervals[i, j] for i in range(len(orders))])

    tardiness_vars = []
    for i, o in enumerate(orders):
        due_hours = max(0, math.floor((o["due_date"] - start).total_seconds() / 3600))
        late = model.new_int_var(0, horizon, f"late_{i}")
        model.add(late >= ends[i, len(routing) - 1] - due_hours)
        tardiness_vars.append(late)

    makespan = model.new_int_var(0, horizon, "makespan")
    model.add_max_equality(makespan, [ends[i, len(routing) - 1] for i in range(len(orders))])
    # Tardiness dominates: an hour of lateness against a promised date costs far more
    # than an hour of idle capacity, so makespan only breaks ties.
    model.minimize(sum(tardiness_vars) * 1000 + makespan)

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60
    status = solver.solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        raise ValueError("CP-SAT could not find a feasible schedule for these inputs")

    def ts(hours: int) -> str:
        return (start + timedelta(hours=hours)).isoformat()

    order_rows = []
    for i, o in enumerate(orders):
        completion_h = solver.value(ends[i, len(routing) - 1])
        late_h = solver.value(tardiness_vars[i])
        order_rows.append(
            {
                "order_id": o["order_id"],
                "quantity": o["quantity"],
                "due_date": o["due_date"].isoformat(),
                "completion": ts(completion_h),
                "hours_late": late_h,
                "on_time": late_h == 0,
                "tasks": [
                    {
                        "machine": routing[j]["machine"],
                        "start": ts(solver.value(starts[i, j])),
                        "end": ts(solver.value(ends[i, j])),
                        "start_h": solver.value(starts[i, j]),
                        "end_h": solver.value(ends[i, j]),
                    }
                    for j in range(len(routing))
                ],
            }
        )
    order_rows.sort(key=lambda r: r["tasks"][0]["start_h"])

    makespan_h = solver.value(makespan)
    return {
        "task_type": "scheduling",
        "solver_status": "optimal" if status == cp_model.OPTIMAL else "feasible (time-limited)",
        "schedule_start": start.isoformat(),
        "makespan_hours": makespan_h,
        "orders_on_time": sum(1 for r in order_rows if r["on_time"]),
        "orders_late": sum(1 for r in order_rows if not r["on_time"]),
        "total_hours_late": sum(r["hours_late"] for r in order_rows),
        "machines": [step["machine"] for step in routing],
        "orders": order_rows,
        "params": {
            "orders_count": len(orders),
            "routing_steps": len(routing),
            "objective": "minimize total tardiness, then makespan",
            "solver": "OR-Tools CP-SAT (exact, not heuristic)",
        },
    }


def run_scheduling(catalogs: list[FileCatalog], upload_dir: Path) -> tuple[dict, str]:
    """Returns (result payload, input-identification reasoning)."""
    inputs = identify_inputs(catalogs, upload_dir)
    return solve_schedule(inputs), inputs.reasoning
