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
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import TYPE_CHECKING, Literal

import pandas as pd
from pydantic import BaseModel

from computation_engine.task_detection import FileCatalog
from understanding_engine.llm_extraction import _call_tool_with_retry

if TYPE_CHECKING:
    from understanding_engine.graph_store import GraphStore


@dataclass
class GraphMaintenanceContext:
    """Everything run_scheduling needs to derive real maintenance windows.
    Optional on purpose: without it, scheduling behaves exactly as before
    this feature existed."""

    store: "GraphStore"
    project_id: str
    maintenance_result: dict | None

_INPUTS_SYSTEM_PROMPT = """You are identifying which uploaded tables hold the inputs a production \
schedule needs, and which column is which. You will see every uploaded CSV's real headers and \
sampled values.

Required inputs:
- The OPEN ORDERS table: one row per pending job/order, with an order identifier column, a \
quantity column (how many units to produce), and a due-date column.
- The ROUTING table: one row per processing step, with a machine/work-center name column, a \
processing-rate column (units per hour), and a step-sequence column (the order steps run in).

Optional inputs:
- The open-orders table MAY also have a priority/rush/urgency/tier column for each order — a \
column whose values distinguish which orders matter more (e.g. "Rush"/"Normal", a numeric \
priority score, a customer tier). This is OPTIONAL: only name it if such a column genuinely \
exists with real values; if there is no such column, set it to null. Never invent one from a \
column that doesn't carry this meaning.
- The routing table MAY also have two columns giving each machine's daily working hours — a \
shift-start time and a shift-end time (e.g. "06:00" and "22:00", meaning that machine only runs \
between those clock times every day). OPTIONAL: only name these if the table genuinely has \
real time-of-day values for them; if machines run continuously or there's no such column, set \
both to null.
- The open-orders table MAY also have a material-ready date column — the date raw material for \
that order actually becomes available, which can be after the order was placed. OPTIONAL: only \
name it if the table genuinely has a real date column carrying this specific meaning (not the \
order date, not the due date); if there is no such column, set it to null.
- The open-orders table MAY also have a product/SKU/item-type column — which distinct product \
each order is for (needed to know when a machine switches products between consecutive orders). \
OPTIONAL: only name it if orders genuinely carry a real product identity in the data.
- The routing table MAY also have a changeover-time column — the hours a machine needs to \
reconfigure when it switches from one product to a different one. OPTIONAL: only name it if the \
table genuinely has a real numeric duration column carrying this specific meaning (not the \
processing rate); if machines need no changeover or there's no such column, set it to null. This \
one only matters together with a product column on the orders table — without knowing each \
order's product, a changeover time can't be applied to anything.

Rules:
- Judge from the actual sampled values, not column names alone.
- A table of HISTORICAL orders that already have recorded outcomes (e.g. an actual lead time \
already measured) is history, not open orders — do not pick it as the open-orders table if a \
genuinely pending-orders table also exists.
- If a required table or column genuinely is not present, set it to null and say so in reasoning \
— an honest "cannot schedule, missing X" beats a wrong guess.
- Your reasoning MUST explicitly address the priority column, the shift-hours columns, the \
material-ready-date column, the product column, AND the changeover-time column before you \
finish: state a yes/no (with the column name if yes) for each, even though all are optional — \
never leave any undecided in your reasoning, and never silently skip them.
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
    priority_column: str | None = None
    material_ready_date_column: str | None = None
    product_column: str | None = None
    routing_file: str | None
    machine_column: str | None
    rate_column: str | None
    sequence_column: str | None
    changeover_hours_column: str | None = None
    shift_start_column: str | None = None
    shift_end_column: str | None = None


class _VerifiedInputs(BaseModel):
    orders: list[dict]
    routing: list[dict]
    reasoning: str
    # Categories seen in the priority column that have no configured weight yet
    # (empty when there's no priority column, or every category is configured).
    priority_categories_needing_weight: list[str] = []


def _is_numeric_str(v: object) -> bool:
    if v is None:
        return False
    s = str(v).strip()
    return bool(s) and s.replace(".", "", 1).replace("-", "", 1).isdigit()


def _priority_setting_key(category: str) -> str:
    return f"scheduling.priority_weight.{category.strip().lower()}"


def _parse_time_of_day(value: object) -> float:
    """Parses 'HH:MM' (or 'HH:MM:SS') into hours-since-midnight as a float."""
    parts = str(value).strip().split(":")
    hours = int(parts[0])
    minutes = int(parts[1]) if len(parts) > 1 else 0
    return hours + minutes / 60


def identify_inputs(
    catalogs: list[FileCatalog], upload_dir: Path, settings: dict[str, str] | None = None,
) -> _VerifiedInputs:
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

    # Priority is optional — only validated/used if the model genuinely found a column for it.
    if decision.priority_column is not None and decision.priority_column not in orders_df.columns:
        raise ValueError(
            f"identified priority column {decision.priority_column!r} does not exist in "
            f"{decision.orders_file!r} — unverifiable, refusing to guess"
        )

    material_ready_dates: list[datetime | None] = [None] * len(orders_df)
    if decision.material_ready_date_column is not None:
        if decision.material_ready_date_column not in orders_df.columns:
            raise ValueError(
                f"identified material-ready-date column {decision.material_ready_date_column!r} does not "
                f"exist in {decision.orders_file!r} — unverifiable, refusing to guess"
            )
        parsed = pd.to_datetime(orders_df[decision.material_ready_date_column], errors="coerce", format="mixed")
        if parsed.isna().any():
            raise ValueError(
                f"material-ready-date column {decision.material_ready_date_column!r} has values that "
                "do not parse as dates"
            )
        material_ready_dates = [d.to_pydatetime() for d in parsed]

    # Shift hours are optional and only meaningful as a pair — a start with no end (or vice
    # versa) can't define a daily window, so refuse rather than guess the missing half.
    has_shift_start = decision.shift_start_column is not None
    has_shift_end = decision.shift_end_column is not None
    if has_shift_start != has_shift_end:
        raise ValueError(
            "identified only one of shift_start_column/shift_end_column — a daily working-hours "
            "window needs both a start and an end; refusing to guess the missing one"
        )
    shift_hours: list[tuple[float, float]] | None = None
    if has_shift_start and has_shift_end:
        for col in (decision.shift_start_column, decision.shift_end_column):
            if col not in routing_df.columns:
                raise ValueError(f"identified shift-hours column {col!r} does not exist in {decision.routing_file!r} — unverifiable, refusing to guess")
        try:
            shift_hours = [
                (_parse_time_of_day(row[decision.shift_start_column]), _parse_time_of_day(row[decision.shift_end_column]))
                for _, row in routing_df.iterrows()
            ]
        except (ValueError, IndexError) as exc:
            raise ValueError(
                f"shift-hours columns {decision.shift_start_column!r}/{decision.shift_end_column!r} "
                f"have values that don't parse as a time of day (HH:MM) — {exc}"
            ) from exc
        for step_start, step_end in shift_hours:
            if not (0 <= step_start < 24 and 0 < step_end <= 24) or step_end <= step_start:
                raise ValueError(
                    f"shift-hours row has start={step_start}, end={step_end} — must be a real "
                    "same-day window (0-24, end after start), refusing to guess an overnight shift"
                )

    # Product identity and changeover time are optional and only meaningful together — a
    # changeover time can't be applied to anything without knowing each order's product.
    if decision.product_column is not None and decision.product_column not in orders_df.columns:
        raise ValueError(
            f"identified product column {decision.product_column!r} does not exist in "
            f"{decision.orders_file!r} — unverifiable, refusing to guess"
        )
    if decision.changeover_hours_column is not None:
        if decision.changeover_hours_column not in routing_df.columns:
            raise ValueError(
                f"identified changeover-hours column {decision.changeover_hours_column!r} does not "
                f"exist in {decision.routing_file!r} — unverifiable, refusing to guess"
            )
        changeover_check = pd.to_numeric(routing_df[decision.changeover_hours_column], errors="coerce")
        if changeover_check.isna().any() or (changeover_check < 0).any():
            raise ValueError(
                f"changeover-hours column {decision.changeover_hours_column!r} has non-numeric or "
                "negative values"
            )

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

    if decision.priority_column is not None:
        raw_priorities = [
            (None if pd.isna(row[decision.priority_column]) else str(row[decision.priority_column]).strip())
            for _, row in orders_df.iterrows()
        ]
    else:
        raw_priorities = [None] * len(orders_df)

    if decision.product_column is not None:
        products = [
            (None if pd.isna(row[decision.product_column]) else str(row[decision.product_column]).strip())
            for _, row in orders_df.iterrows()
        ]
    else:
        products = [None] * len(orders_df)

    changeover_hours_by_step: list[float | None]
    if decision.changeover_hours_column is not None:
        changeover_hours_by_step = [float(v) for v in changeover_check]
    else:
        changeover_hours_by_step = [None] * len(routing_df)

    orders = [
        {
            "order_id": str(row[decision.order_id_column]), "quantity": int(q), "due_date": d.to_pydatetime(),
            "priority": p, "material_ready_date": mrd, "product": prod,
        }
        for (_, row), q, d, p, mrd, prod in zip(
            orders_df.iterrows(), quantities, due_dates, raw_priorities, material_ready_dates, products
        )
    ]
    routing_rows = list(routing_df.iterrows())
    routing = sorted(
        (
            {
                "machine": str(row[decision.machine_column]), "rate": float(r), "sequence": int(s),
                "shift_start_hour": shift_hours[idx][0] if shift_hours else None,
                "shift_end_hour": shift_hours[idx][1] if shift_hours else None,
                "changeover_hours": changeover_hours_by_step[idx],
            }
            for idx, ((_, row), r, s) in enumerate(zip(routing_rows, rates, sequences))
        ),
        key=lambda step: step["sequence"],
    )

    # If the priority values are categorical (not already numeric), each distinct category
    # needs a human-supplied weight in project settings — how much more a "Rush" order should
    # matter than a "Normal" one is a business policy call, never a number the LLM invents.
    needing_weight: list[str] = []
    real_values = [p for p in raw_priorities if p is not None]
    if real_values and not all(_is_numeric_str(v) for v in real_values):
        settings = settings or {}
        seen = set()
        for v in real_values:
            key = v.strip().lower()
            if key in seen:
                continue
            seen.add(key)
            if settings.get(_priority_setting_key(v)) is None:
                needing_weight.append(v)

    return _VerifiedInputs(
        orders=orders, routing=routing, reasoning=decision.reasoning,
        priority_categories_needing_weight=sorted(needing_weight),
    )


def _off_shift_intervals(
    shift_start_hour: float, shift_end_hour: float, schedule_start: datetime, horizon: int,
) -> list[tuple[int, int]]:
    """Daily off-hours windows (midnight-to-shift-start, shift-end-to-midnight),
    as (start_hour, end_hour) relative to schedule_start, clamped to [0, horizon].
    Repeats every calendar day the schedule spans — a real, recurring fact from
    the routing data, not a one-off guess."""
    windows: list[tuple[int, int]] = []
    day_start = schedule_start.replace(hour=0, minute=0, second=0, microsecond=0)
    num_days = int(horizon / 24) + 2
    for d in range(-1, num_days):
        this_day_offset = (day_start + timedelta(days=d) - schedule_start).total_seconds() / 3600
        morning = (this_day_offset, this_day_offset + shift_start_hour)
        evening = (this_day_offset + shift_end_hour, this_day_offset + 24)
        for w_start, w_end in (morning, evening):
            clipped_start = max(0.0, w_start)
            clipped_end = min(float(horizon), w_end)
            if clipped_end > clipped_start:
                windows.append((int(round(clipped_start)), int(round(clipped_end))))
    return windows


def _resolve_priority_weights(orders: list[dict], settings: dict[str, str] | None) -> list[int]:
    """Per-order integer weight for the tardiness objective.

    Defaults to 1 (no differentiation) wherever there's no priority data, or a
    category has no configured weight yet — never invented. CP-SAT needs integer
    objective coefficients, so a numeric priority value or a configured weight is
    rounded to the nearest whole number rather than scaled by some arbitrary factor;
    this also means when there's no priority column at all, every weight is exactly
    1 and the objective is mathematically identical to before this feature existed.
    """
    settings = settings or {}
    weights = []
    for o in orders:
        raw = o.get("priority")
        if raw is None:
            weights.append(1)
        elif _is_numeric_str(raw):
            weights.append(max(1, round(float(raw))))
        else:
            configured = settings.get(_priority_setting_key(raw))
            weights.append(max(1, round(float(configured))) if configured is not None else 1)
    return weights


def solve_schedule(
    inputs: _VerifiedInputs,
    settings: dict[str, str] | None = None,
    schedule_start: datetime | None = None,
    maintenance_windows: dict[str, list[tuple[int, int]]] | None = None,
) -> dict:
    from ortools.sat.python import cp_model

    from .maintenance_windows import merge_windows

    orders = inputs.orders
    routing = inputs.routing
    # Overlapping blockers on one machine would conflict with each other inside
    # add_no_overlap and make every schedule infeasible, so the union is enforced here
    # too — not just at the one call site that builds these — because "infeasible" gives
    # no hint that the inputs, rather than the orders, were the problem.
    maintenance_windows = {m: merge_windows(ws) for m, ws in (maintenance_windows or {}).items()}
    # The schedule starts now (rounded up to the next full hour): planning the past
    # would be meaningless, and every due date is measured against this same origin.
    start = schedule_start or datetime.now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)

    durations = [
        [max(1, math.ceil(o["quantity"] / step["rate"])) for step in routing]
        for o in orders
    ]

    # A task can't be split across a shift boundary in this model (one interval, one
    # contiguous block) — if a single order's processing time on a shift-restricted
    # machine is longer than that machine's own daily window, say exactly why instead
    # of surfacing a generic "infeasible" the user can't act on.
    for j, step in enumerate(routing):
        if step.get("shift_start_hour") is None:
            continue
        window_size = step["shift_end_hour"] - step["shift_start_hour"]
        if window_size >= 24:
            continue
        for i, o in enumerate(orders):
            if durations[i][j] > window_size:
                raise ValueError(
                    f"order {o['order_id']!r} needs {durations[i][j]}h on {step['machine']!r}, but its "
                    f"shift window is only {window_size:g}h/day — this task can't fit in one shift. "
                    "Widen the shift hours, split the order into smaller batches, or remove the shift "
                    "restriction for this machine."
                )

    horizon = sum(sum(d) for d in durations)
    # A predicted maintenance window can sit further out than the orders alone would
    # need — the horizon must reach it, or the fixed interval below wouldn't fit the
    # variables' own domain.
    for step_windows in maintenance_windows.values():
        for _w_start, w_end in step_windows:
            horizon = max(horizon, w_end)
    # A machine only available part of each day needs proportionally more wall-clock
    # time to fit the same processing hours — inflate the horizon by the real usable
    # fraction (a derived fact from the shift columns, not an invented buffer), plus a
    # small fixed safety margin for day-boundary effects.
    min_usable_fraction = 1.0
    for step in routing:
        if step.get("shift_start_hour") is not None:
            fraction = (step["shift_end_hour"] - step["shift_start_hour"]) / 24
            if fraction > 0:
                min_usable_fraction = min(min_usable_fraction, fraction)
    if min_usable_fraction < 1.0:
        horizon = math.ceil(horizon / min_usable_fraction) + 48
    # A late material-ready date can itself push an order's own start past the
    # horizon estimated from durations alone — the horizon must reach far enough
    # for that order to still fit all its own steps after waiting.
    for i, o in enumerate(orders):
        ready_date = o.get("material_ready_date")
        if ready_date is not None:
            ready_hour = max(0, math.ceil((ready_date - start).total_seconds() / 3600))
            horizon = max(horizon, ready_hour + sum(durations[i]))
    # Every consecutive product switch on a machine could in the worst case add one
    # full changeover — a real (if pessimistic) upper bound, not an invented buffer.
    # CP-SAT needs whole-hour integer durations, same granularity as everything else
    # in this model, so a fractional changeover time is rounded up, never down.
    horizon += sum(
        max(0, len(orders) - 1) * math.ceil(step["changeover_hours"])
        for step in routing
        if step.get("changeover_hours")
    )
    horizon = int(horizon)

    model = cp_model.CpModel()
    starts, ends, intervals = {}, {}, {}
    material_gated: dict[str, int] = {}
    for i, o in enumerate(orders):
        for j, _step in enumerate(routing):
            starts[i, j] = model.new_int_var(0, horizon, f"s_{i}_{j}")
            ends[i, j] = model.new_int_var(0, horizon, f"e_{i}_{j}")
            intervals[i, j] = model.new_interval_var(starts[i, j], durations[i][j], ends[i, j], f"iv_{i}_{j}")
            if j > 0:
                model.add(starts[i, j] >= ends[i, j - 1])
        # An order simply can't start its first step before its own raw material is
        # physically on hand — a real lower bound, not a preference the solver can trade off.
        ready_date = o.get("material_ready_date")
        if ready_date is not None:
            ready_hour = max(0, math.ceil((ready_date - start).total_seconds() / 3600))
            if ready_hour > 0:
                model.add(starts[i, 0] >= ready_hour)
                material_gated[o["order_id"]] = ready_hour

    off_shift_by_machine: dict[str, list[tuple[int, int]]] = {}
    for j, step in enumerate(routing):
        # A predicted-attention window is modeled as an already-occupied slot on
        # this same machine — real orders simply can't be placed inside it,
        # exactly like another order already holding the machine.
        blockers = [
            model.new_interval_var(w_start, w_end - w_start, w_end, f"maint_{j}_{k}")
            for k, (w_start, w_end) in enumerate(maintenance_windows.get(step["machine"], []))
            if w_end > w_start
        ]
        if step.get("shift_start_hour") is not None and step.get("shift_end_hour") is not None:
            off_shift = _off_shift_intervals(step["shift_start_hour"], step["shift_end_hour"], start, horizon)
            off_shift_by_machine[step["machine"]] = off_shift
            blockers += [
                model.new_interval_var(w_start, w_end - w_start, w_end, f"shift_{j}_{k}")
                for k, (w_start, w_end) in enumerate(off_shift)
                if w_end > w_start
            ]
        model.add_no_overlap([intervals[i, j] for i in range(len(orders))] + blockers)

        # Sequence-dependent setup time: whichever order runs second on this machine must
        # wait an extra gap after the first one finishes, but ONLY when they're genuinely
        # different products — same product back-to-back needs no changeover. Unknown
        # product (None) is never assumed different; no product data means no gap enforced.
        changeover_h = step.get("changeover_hours")
        if changeover_h:
            gap = math.ceil(changeover_h)
            for i1 in range(len(orders)):
                for i2 in range(i1 + 1, len(orders)):
                    p1, p2 = orders[i1].get("product"), orders[i2].get("product")
                    pair_gap = gap if (p1 is not None and p2 is not None and p1 != p2) else 0
                    if pair_gap == 0:
                        continue
                    before = model.new_bool_var(f"before_{i1}_{i2}_{j}")
                    model.add(starts[i2, j] >= ends[i1, j] + pair_gap).only_enforce_if(before)
                    model.add(starts[i1, j] >= ends[i2, j] + pair_gap).only_enforce_if(before.Not())

    tardiness_vars = []
    for i, o in enumerate(orders):
        due_hours = max(0, math.floor((o["due_date"] - start).total_seconds() / 3600))
        late = model.new_int_var(0, horizon, f"late_{i}")
        model.add(late >= ends[i, len(routing) - 1] - due_hours)
        tardiness_vars.append(late)

    makespan = model.new_int_var(0, horizon, "makespan")
    model.add_max_equality(makespan, [ends[i, len(routing) - 1] for i in range(len(orders))])
    weights = _resolve_priority_weights(orders, settings)
    # Tardiness dominates: an hour of lateness against a promised date costs far more
    # than an hour of idle capacity, so makespan only breaks ties. A higher-priority
    # order's lateness counts more toward that dominant term via its weight (1 when
    # there's no priority data — identical to the unweighted objective).
    model.minimize(sum(tardiness_vars[i] * weights[i] for i in range(len(orders))) * 1000 + makespan)

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
                "priority": o.get("priority"),
                "priority_weight": weights[i],
                "product": o.get("product"),
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
            "priority_weighted": any(w != 1 for w in weights),
            "priority_categories_needing_weight": inputs.priority_categories_needing_weight,
            "maintenance_windows_applied": {
                machine: [{"start": ts(w[0]), "end": ts(w[1])} for w in windows]
                for machine, windows in maintenance_windows.items()
                if windows
            },
            "shift_calendar_applied": {
                step["machine"]: {"start": f"{step['shift_start_hour']:.2f}", "end": f"{step['shift_end_hour']:.2f}"}
                for step in routing
                if step.get("shift_start_hour") is not None
            },
            # Concrete off-shift blocks within the actual plan (not the padded solver
            # horizon) — real ISO datetimes, same shape as maintenance_windows_applied,
            # so the frontend renders both the same way.
            "off_shift_blocks": {
                machine: [{"start": ts(w[0]), "end": ts(min(w[1], makespan_h))} for w in windows if w[0] < makespan_h]
                for machine, windows in off_shift_by_machine.items()
            },
            "material_gated_orders": {order_id: ts(hour) for order_id, hour in material_gated.items()},
            "changeover_applied": {
                step["machine"]: step["changeover_hours"]
                for step in routing
                if step.get("changeover_hours") and any(o.get("product") is not None for o in orders)
            },
        },
    }


def run_scheduling(
    catalogs: list[FileCatalog],
    upload_dir: Path,
    settings: dict[str, str] | None = None,
    graph_context: GraphMaintenanceContext | None = None,
) -> tuple[dict, str]:
    """Returns (result payload, input-identification reasoning). graph_context,
    when given, lets predicted maintenance windows block the schedule — absent
    it, scheduling behaves exactly as before this feature existed."""
    inputs = identify_inputs(catalogs, upload_dir, settings)

    schedule_start = datetime.now().replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)
    maintenance_windows: dict[str, list[tuple[int, int]]] = {}
    if graph_context is not None:
        from .maintenance_windows import find_maintenance_windows

        routing_machines = [step["machine"] for step in inputs.routing]
        maintenance_windows = find_maintenance_windows(
            graph_context.store, graph_context.project_id, routing_machines,
            graph_context.maintenance_result, schedule_start,
        )

    result = solve_schedule(inputs, settings, schedule_start, maintenance_windows)

    from .recommendations import generate_recommendations

    result["recommendations"] = generate_recommendations(
        inputs, settings, schedule_start, maintenance_windows, result
    )
    return result, inputs.reasoning
