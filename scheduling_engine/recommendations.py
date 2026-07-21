"""Recommendations for a solved schedule — every one either a real derived
fact from the solve itself, or an actual re-solve with one real constraint
adjusted by an exact amount and re-verified, never a guessed number or a
canned rule.
"""

from datetime import datetime, timedelta

from .solver import _VerifiedInputs, solve_schedule


def _bottleneck_machine(result: dict) -> dict | None:
    """The work center with the highest share of the makespan actually busy —
    a real derived fact (busy hours / makespan), not an opinion."""
    makespan = result.get("makespan_hours") or 0
    if makespan <= 0:
        return None
    busy_hours: dict[str, int] = {}
    for order in result.get("orders", []):
        for task in order.get("tasks", []):
            busy_hours[task["machine"]] = busy_hours.get(task["machine"], 0) + (task["end_h"] - task["start_h"])
    if not busy_hours:
        return None
    machine, hours = max(busy_hours.items(), key=lambda kv: kv[1])
    return {"machine": machine, "utilization_pct": round(hours / makespan * 100)}


def _worst_late_order(result: dict) -> dict | None:
    late = [o for o in result.get("orders", []) if o.get("hours_late", 0) > 0]
    if not late:
        return None
    return max(late, key=lambda o: o["hours_late"])


def _shrink_maintenance_window_recommendation(
    inputs: _VerifiedInputs,
    settings: dict[str, str] | None,
    schedule_start: datetime,
    maintenance_windows: dict[str, list[tuple[int, int]]],
    base_result: dict,
) -> dict | None:
    """Tries shrinking each machine's maintenance window from the end, one
    hour at a time, and re-solves for real each time — stops at the first
    shrink that actually reduces the worst order's lateness, and reports
    exactly that amount and exactly what it bought. No estimate: every
    number here comes from an actual second solve."""
    worst = _worst_late_order(base_result)
    if worst is None:
        return None

    for machine, windows in maintenance_windows.items():
        for w_idx, (w_start, w_end) in enumerate(windows):
            window_size = w_end - w_start
            if window_size <= 0:
                continue
            # Bounded, real search: try shrinking the window from its end, one hour
            # at a time, up to its own size — never an unbounded or invented range.
            for shrink in range(1, min(window_size, 24) + 1):
                trial_windows = {
                    m: [w if not (m == machine and i == w_idx) else (w_start, w_end - shrink) for i, w in enumerate(ws)]
                    for m, ws in maintenance_windows.items()
                }
                trial_result = solve_schedule(inputs, settings, schedule_start, trial_windows)
                trial_worst = next((o for o in trial_result["orders"] if o["order_id"] == worst["order_id"]), None)
                if trial_worst is None:
                    continue
                if trial_worst["hours_late"] < worst["hours_late"]:
                    new_total_late = trial_result["total_hours_late"]
                    old_total_late = base_result["total_hours_late"]
                    return {
                        "type": "shrink_maintenance_window",
                        "machine": machine,
                        "shrink_hours": shrink,
                        "order_id": worst["order_id"],
                        "hours_late_before": worst["hours_late"],
                        "hours_late_after": trial_worst["hours_late"],
                        "total_hours_late_before": old_total_late,
                        "total_hours_late_after": new_total_late,
                    }
    return None


def _expedite_material_recommendation(
    inputs: _VerifiedInputs,
    settings: dict[str, str] | None,
    schedule_start: datetime,
    maintenance_windows: dict[str, list[tuple[int, int]]],
    base_result: dict,
) -> dict | None:
    """Same real, bounded, re-solved search as the maintenance-window shrink —
    tries moving a late gated order's material-ready date earlier by one hour
    at a time (up to 48h) and re-solves for real each time, stopping at the
    first genuine improvement."""
    gated = base_result["params"].get("material_gated_orders") or {}
    late_by_id = {o["order_id"]: o for o in base_result["orders"] if o.get("hours_late", 0) > 0}
    candidates = [oid for oid in gated if oid in late_by_id]
    if not candidates:
        return None
    order_id = max(candidates, key=lambda oid: late_by_id[oid]["hours_late"])
    worst = late_by_id[order_id]

    for shift in range(1, 49):
        trial_orders = [
            {
                **o,
                "material_ready_date": (
                    datetime.fromisoformat(gated[o["order_id"]]) - timedelta(hours=shift)
                    if o["order_id"] == order_id
                    else o.get("material_ready_date")
                ),
            }
            for o in inputs.orders
        ]
        trial_inputs = inputs.model_copy(update={"orders": trial_orders})
        trial_result = solve_schedule(trial_inputs, settings, schedule_start, maintenance_windows)
        trial_worst = next((o for o in trial_result["orders"] if o["order_id"] == order_id), None)
        if trial_worst is None:
            continue
        if trial_worst["hours_late"] < worst["hours_late"]:
            return {
                "type": "expedite_material",
                "order_id": order_id,
                "shift_hours": shift,
                "hours_late_before": worst["hours_late"],
                "hours_late_after": trial_worst["hours_late"],
                "total_hours_late_before": base_result["total_hours_late"],
                "total_hours_late_after": trial_result["total_hours_late"],
            }
    return None


def generate_recommendations(
    inputs: _VerifiedInputs,
    settings: dict[str, str] | None,
    schedule_start: datetime,
    maintenance_windows: dict[str, list[tuple[int, int]]],
    base_result: dict,
) -> list[dict]:
    """Every recommendation is either a real fact read straight from
    base_result, or a real re-solve with one exact, bounded change — never a
    canned suggestion. Returns however many genuinely apply, including zero."""
    recs: list[dict] = []

    bottleneck = _bottleneck_machine(base_result)
    if bottleneck is not None:
        recs.append({"type": "bottleneck_machine", **bottleneck})

    if maintenance_windows:
        window_rec = _shrink_maintenance_window_recommendation(
            inputs, settings, schedule_start, maintenance_windows, base_result
        )
        if window_rec is not None:
            recs.append(window_rec)

    if base_result["params"].get("priority_weighted"):
        weighted_late = [
            o for o in base_result["orders"]
            if o.get("hours_late", 0) > 0 and (o.get("priority_weight") or 1) > 1
        ]
        if weighted_late:
            worst_weighted = max(weighted_late, key=lambda o: o["priority_weight"])
            recs.append({
                "type": "weighted_order_still_late",
                "order_id": worst_weighted["order_id"],
                "priority": worst_weighted.get("priority"),
                "priority_weight": worst_weighted["priority_weight"],
                "hours_late": worst_weighted["hours_late"],
            })

    if base_result["params"].get("material_gated_orders"):
        material_rec = _expedite_material_recommendation(
            inputs, settings, schedule_start, maintenance_windows, base_result
        )
        if material_rec is not None:
            recs.append(material_rec)

    return recs
