"""Production-mix LP: how much of each product to make, on which machine, to
best satisfy whichever goal the user picked — subject to whichever
constraints the user has turned on.

GLOP (OR-Tools' linear solver) reports INFEASIBLE / UNBOUNDED as a bare status
with no explanation of which constraint or product caused it. Every failure
mode this model can actually produce is checked in closed form BEFORE the
solver runs, so a human always gets a named reason:

- missing_inputs: the chosen objective needs a field (price/cost) a product
  doesn't have.
- no_compatible_machine: a product has a floor (min order / min batch) to
  meet but no machine can make it at all.
- infeasible (capacity): every product sitting at its own floor already
  exceeds some machine's or resource's capacity — checking that single point
  is exact (every coefficient and every floor is non-negative), not a guess.
- infeasible (utilization_floor_unreachable): a machine's utilization floor
  can't be reached even if every compatible product ran flat-out to its own
  ceiling.

Once machine capacity is always-on and finite, classical LP unboundedness
cannot occur for the four maximizing objectives — every variable sits inside
a bounded polytope. The two minimizing objectives (cost, makespan) can
instead have a trivial "produce nothing" optimum when no floor forces
production; that's an honest, correct answer, not a failure, so it's
reported as a `degenerate_note` rather than a blocking verdict.
"""

from ortools.linear_solver import pywraplp

_EPS = 1e-9

_OBJECTIVE_LABELS = {
    "maximize_profit": "Total profit",
    "maximize_revenue": "Total revenue",
    "minimize_cost": "Total cost",
    "maximize_utilization": "Average machine utilization",
    "maximize_throughput": "Total units produced",
    "minimize_makespan": "Machine-load proxy (lower is more even/faster)",
}

_OBJECTIVE_FIELD = {
    # objective -> product field it needs on every product with a compatible
    # machine; None means no per-product field beyond what's always present.
    "maximize_profit": None,       # profit_per_unit is NOT NULL on every row
    "maximize_revenue": "price_per_unit",
    "minimize_cost": "cost_per_unit",
    "maximize_utilization": None,
    "maximize_throughput": None,
    "minimize_makespan": None,
}

_MINIMIZING = {"minimize_cost", "minimize_makespan"}


def _compatible_machines(product_id: str, machines: list[dict], compatibility: dict) -> list[dict]:
    return [m for m in machines if compatibility.get((product_id, m["id"]), 0.0) > 0]


def _compatible_products_for_machine(machine_id: str, products: list[dict], compatibility: dict) -> list[dict]:
    return [p for p in products if compatibility.get((p["id"], machine_id), 0.0) > 0]


def _avail_adjusted(machine: dict) -> float:
    return max(0.0, machine["available_hours"] - machine.get("downtime_hours", 0.0))


def _effective_floor(product: dict, toggles: dict, defect_rate: float) -> float:
    components = []
    if toggles.get("min_committed_order") and product.get("demand_min"):
        components.append(product["demand_min"])
    if toggles.get("batch_size") and product.get("batch_min"):
        components.append(product["batch_min"])
    floor = max(components) if components else 0.0
    if floor > 0 and defect_rate > 0:
        floor = floor / (1 - defect_rate)
    return floor


def _raw_floor(product: dict, toggles: dict) -> float:
    components = []
    if toggles.get("min_committed_order") and product.get("demand_min"):
        components.append(product["demand_min"])
    if toggles.get("batch_size") and product.get("batch_min"):
        components.append(product["batch_min"])
    return max(components) if components else 0.0


def _effective_ceiling(product: dict, toggles: dict) -> float | None:
    components = []
    if toggles.get("demand_ceiling") and product.get("demand_max") is not None:
        components.append(product["demand_max"])
    if toggles.get("batch_size") and product.get("batch_max") is not None:
        components.append(product["batch_max"])
    return min(components) if components else None


def solve_production_mix(
    products: list[dict],
    machines: list[dict],
    resources: list[dict],
    compatibility: dict[tuple[str, str], float],
    consumption: dict[tuple[str, str], float],
    objective: str,
    toggles: dict[str, bool],
    defect_rate: float = 0.0,
) -> dict:
    if not products:
        return {"verdict": "empty", "message": "No products defined yet — add at least one product to generate a plan."}
    if not machines:
        return {"verdict": "empty", "message": "No machines defined yet — add at least one machine to generate a plan."}
    if objective not in _OBJECTIVE_LABELS:
        return {"verdict": "error", "message": f"Unknown objective {objective!r}."}

    floors = {p["id"]: _effective_floor(p, toggles, defect_rate) for p in products}
    raw_floors = {p["id"]: _raw_floor(p, toggles) for p in products}
    ceilings = {p["id"]: _effective_ceiling(p, toggles) for p in products}

    # ---- missing_inputs: the chosen objective needs a field some product lacks ----
    needed_field = _OBJECTIVE_FIELD[objective]
    if needed_field:
        missing = [
            {"product_id": p["id"], "product_name": p["name"], "missing_field": needed_field}
            for p in products
            if _compatible_machines(p["id"], machines, compatibility) and p.get(needed_field) is None
        ]
        if missing:
            names = ", ".join(m["product_name"] for m in missing)
            return {
                "verdict": "missing_inputs",
                "message": f"{_OBJECTIVE_LABELS[objective]!r} needs {needed_field.replace('_', ' ')} set on: {names}.",
                "products": missing,
            }

    # ---- no_compatible_machine: a product has a floor but nothing can make it ----
    no_machine = [
        {"product_id": p["id"], "product_name": p["name"], "required": floors[p["id"]]}
        for p in products
        if floors[p["id"]] > _EPS and not _compatible_machines(p["id"], machines, compatibility)
    ]
    if no_machine:
        names = ", ".join(f"{n['product_name']} (needs {n['required']:g})" for n in no_machine)
        return {
            "verdict": "infeasible",
            "message": f"No compatible machine exists for a committed minimum: {names}.",
            "conflicts": [{"kind": "no_compatible_machine", **n} for n in no_machine],
        }

    # ---- capacity pre-check: every product at its own floor, simultaneously ----
    conflicts = []
    for m in machines:
        avail_adj = _avail_adjusted(m)
        minimum_required = sum(compatibility.get((p["id"], m["id"]), 0.0) * floors[p["id"]] for p in products)
        if minimum_required > avail_adj + _EPS:
            driven_by = sorted(
                (
                    {
                        "product_id": p["id"], "product_name": p["name"], "demand_min": floors[p["id"]],
                        "per_unit": compatibility.get((p["id"], m["id"]), 0.0),
                        "contribution": compatibility.get((p["id"], m["id"]), 0.0) * floors[p["id"]],
                    }
                    for p in products
                    if floors[p["id"]] > 0 and compatibility.get((p["id"], m["id"]), 0.0) > 0
                ),
                key=lambda d: d["contribution"], reverse=True,
            )
            conflicts.append({
                "kind": "capacity", "row_type": "machine", "row_id": m["id"], "row_name": m["name"], "unit": "hours",
                "available": avail_adj, "minimum_required": minimum_required, "driven_by": driven_by,
            })
    if toggles.get("pooled_resources"):
        for r in resources:
            minimum_required = sum(consumption.get((p["id"], r["id"]), 0.0) * floors[p["id"]] for p in products)
            if minimum_required > r["available_capacity"] + _EPS:
                driven_by = sorted(
                    (
                        {
                            "product_id": p["id"], "product_name": p["name"], "demand_min": floors[p["id"]],
                            "per_unit": consumption.get((p["id"], r["id"]), 0.0),
                            "contribution": consumption.get((p["id"], r["id"]), 0.0) * floors[p["id"]],
                        }
                        for p in products
                        if floors[p["id"]] > 0 and consumption.get((p["id"], r["id"]), 0.0) > 0
                    ),
                    key=lambda d: d["contribution"], reverse=True,
                )
                conflicts.append({
                    "kind": "capacity", "row_type": "resource", "row_id": r["id"], "row_name": r["name"],
                    "unit": r["unit"], "available": r["available_capacity"], "minimum_required": minimum_required,
                    "driven_by": driven_by,
                })
    if conflicts:
        names = ", ".join(f"{c['row_name']} (needs {c['minimum_required']:g}, has {c['available']:g})" for c in conflicts)
        return {
            "verdict": "infeasible",
            "message": f"Committed minimum quantities alone exceed available capacity for: {names}.",
            "conflicts": conflicts,
        }

    # ---- utilization-floor-unreachable: floor can't be hit even at full ceiling ----
    if toggles.get("utilization_floor"):
        for m in machines:
            floor_frac = m.get("utilization_floor")
            if not floor_frac:
                continue
            avail_adj = _avail_adjusted(m)
            floor_required_hours = floor_frac * avail_adj
            compatible = _compatible_products_for_machine(m["id"], products, compatibility)
            if any(ceilings[p["id"]] is None for p in compatible):
                continue  # some compatible product has no ceiling -> floor always reachable
            max_achievable = sum(compatibility[(p["id"], m["id"])] * (ceilings[p["id"]] or 0) for p in compatible)
            if floor_required_hours > max_achievable + _EPS:
                return {
                    "verdict": "infeasible",
                    "message": f"{m['name']}'s utilization floor needs {floor_required_hours:g}h, but even running "
                    f"every compatible product to its own ceiling only reaches {max_achievable:g}h.",
                    "conflicts": [{
                        "kind": "utilization_floor_unreachable", "machine_id": m["id"], "machine_name": m["name"],
                        "floor_required_hours": floor_required_hours, "max_achievable_hours": max_achievable,
                    }],
                }

    # ---- build and solve the LP ----
    solver = pywraplp.Solver.CreateSolver("GLOP")
    if solver is None:
        return {"verdict": "error", "message": "Could not create the GLOP linear solver."}

    x: dict[tuple[str, str], object] = {}
    for p in products:
        for m in machines:
            rate = compatibility.get((p["id"], m["id"]), 0.0)
            if rate > 0:
                x[p["id"], m["id"]] = solver.NumVar(0, solver.infinity(), f"x_{p['id']}_{m['id']}")

    avail_adj = {m["id"]: _avail_adjusted(m) for m in machines}

    machine_constraints = {}
    for m in machines:
        vars_for_m = [(p, x[p["id"], m["id"]]) for p in products if (p["id"], m["id"]) in x]
        if not vars_for_m:
            continue
        c = solver.Constraint(-solver.infinity(), avail_adj[m["id"]], f"cap_{m['id']}")
        for p, var in vars_for_m:
            c.SetCoefficient(var, compatibility[p["id"], m["id"]])
        machine_constraints[m["id"]] = c

    resource_constraints = {}
    if toggles.get("pooled_resources"):
        for r in resources:
            coeffs = [(key, consumption.get((key[0], r["id"]), 0.0)) for key in x]
            if not any(c > 0 for _, c in coeffs):
                continue
            c = solver.Constraint(-solver.infinity(), r["available_capacity"], f"res_{r['id']}")
            for key, coeff in coeffs:
                if coeff > 0:
                    c.SetCoefficient(x[key], coeff)
            resource_constraints[r["id"]] = c

    for p in products:
        pid = p["id"]
        p_vars = [x[pid, m["id"]] for m in machines if (pid, m["id"]) in x]
        if not p_vars:
            continue
        if ceilings[pid] is not None:
            c = solver.Constraint(-solver.infinity(), ceilings[pid], f"ceil_{pid}")
            for var in p_vars:
                c.SetCoefficient(var, 1.0)
        if floors[pid] > 0:
            c = solver.Constraint(floors[pid], solver.infinity(), f"floor_{pid}")
            for var in p_vars:
                c.SetCoefficient(var, 1.0)

    if toggles.get("utilization_floor"):
        for m in machines:
            floor_frac = m.get("utilization_floor")
            if not floor_frac:
                continue
            vars_for_m = [(p, x[p["id"], m["id"]]) for p in products if (p["id"], m["id"]) in x]
            if not vars_for_m:
                continue
            c = solver.Constraint(floor_frac * avail_adj[m["id"]], solver.infinity(), f"util_floor_{m['id']}")
            for p, var in vars_for_m:
                c.SetCoefficient(var, compatibility[p["id"], m["id"]])

    makespan_var = None
    objective_fn = solver.Objective()
    if objective == "maximize_profit":
        for (pid, mid), var in x.items():
            objective_fn.SetCoefficient(var, next(p["profit_per_unit"] for p in products if p["id"] == pid))
        objective_fn.SetMaximization()
    elif objective == "maximize_revenue":
        for (pid, mid), var in x.items():
            objective_fn.SetCoefficient(var, next(p["price_per_unit"] for p in products if p["id"] == pid))
        objective_fn.SetMaximization()
    elif objective == "minimize_cost":
        for (pid, mid), var in x.items():
            objective_fn.SetCoefficient(var, next(p["cost_per_unit"] for p in products if p["id"] == pid))
        objective_fn.SetMinimization()
    elif objective == "maximize_throughput":
        for var in x.values():
            objective_fn.SetCoefficient(var, 1.0)
        objective_fn.SetMaximization()
    elif objective == "maximize_utilization":
        for (pid, mid), var in x.items():
            if avail_adj[mid] > 0:
                objective_fn.SetCoefficient(var, compatibility[pid, mid] / avail_adj[mid])
        objective_fn.SetMaximization()
    elif objective == "minimize_makespan":
        makespan_var = solver.NumVar(0, solver.infinity(), "makespan_proxy")
        for m in machines:
            vars_for_m = [(p, x[p["id"], m["id"]]) for p in products if (p["id"], m["id"]) in x]
            if not vars_for_m or avail_adj[m["id"]] <= 0:
                continue
            c = solver.Constraint(-solver.infinity(), 0, f"makespan_{m['id']}")
            c.SetCoefficient(makespan_var, -1.0)
            for p, var in vars_for_m:
                c.SetCoefficient(var, compatibility[p["id"], m["id"]] / avail_adj[m["id"]])
        objective_fn.SetCoefficient(makespan_var, 1.0)
        objective_fn.SetMinimization()

    status = solver.Solve()
    if status != pywraplp.Solver.OPTIMAL:
        return {
            "verdict": "error",
            "message": f"GLOP returned an unexpected status ({status}) despite passing every feasibility check — "
            "this needs investigation, not a guessed explanation.",
        }

    total_quantity = sum(var.solution_value() for var in x.values())
    degenerate_note = None
    if objective in _MINIMIZING and total_quantity < _EPS:
        degenerate_note = (
            "No minimum-commitment constraints are active, so minimizing this trivially recommends producing "
            "nothing. Turn on 'Minimum committed order' and/or 'Min/max batch size' for a meaningful plan."
        )

    product_rows = []
    quality_risk = []
    for p in products:
        pid = p["id"]
        by_machine = {m["id"]: x[pid, m["id"]].solution_value() for m in machines if (pid, m["id"]) in x}
        quantity = sum(by_machine.values())
        row = {
            "product_id": pid, "name": p["name"], "quantity": quantity,
            "profit_per_unit": p["profit_per_unit"], "profit_contribution": quantity * p["profit_per_unit"],
            "by_machine": by_machine,
            "demand_min": p.get("demand_min"), "demand_max": p.get("demand_max"),
            "raw_floor": raw_floors[pid], "production_target": floors[pid] if floors[pid] > 0 else None,
        }
        if toggles.get("demand_ceiling") and p.get("demand_max"):
            row["demand_fulfillment_pct"] = min(100.0, quantity / p["demand_max"] * 100)
        else:
            row["demand_fulfillment_pct"] = None
        product_rows.append(row)
        if floors[pid] > raw_floors[pid] + _EPS:
            quality_risk.append({
                "product_id": pid, "name": p["name"], "raw_floor": raw_floors[pid],
                "inflated_floor": floors[pid], "extra_units": floors[pid] - raw_floors[pid],
            })

    machine_rows = []
    for m in machines:
        used = sum(
            compatibility.get((p["id"], m["id"]), 0.0) * x[p["id"], m["id"]].solution_value()
            for p in products if (p["id"], m["id"]) in x
        )
        c = machine_constraints.get(m["id"])
        shadow_price = c.dual_value() if c is not None else 0.0
        # binding = "is this actually at its limit" (a direct, always-reliable fact),
        # not just "does this constraint have a nonzero shadow price" — when two
        # constraints happen to be tight at the same optimal vertex (a degenerate
        # LP solution), GLOP can legitimately report a zero dual for one of them
        # even though it's fully used; checking usage directly never has that gap.
        binding = abs(shadow_price) > _EPS or used >= avail_adj[m["id"]] - _EPS
        machine_rows.append({
            "machine_id": m["id"], "name": m["name"], "used_hours": used,
            "available_hours": m["available_hours"], "downtime_hours": m.get("downtime_hours", 0.0),
            "downtime_tier": m.get("downtime_tier", "none"),
            "utilization_pct": (used / avail_adj[m["id"]] * 100) if avail_adj[m["id"]] > 0 else 0.0,
            "binding": binding, "shadow_price": shadow_price,
        })

    resource_rows = []
    for r in resources:
        used = sum(
            consumption.get((p["id"], r["id"]), 0.0) * x[p["id"], m["id"]].solution_value()
            for p in products for m in machines if (p["id"], m["id"]) in x
        )
        c = resource_constraints.get(r["id"])
        shadow_price = c.dual_value() if c is not None else 0.0
        binding = abs(shadow_price) > _EPS or used >= r["available_capacity"] - _EPS
        resource_rows.append({
            "resource_id": r["id"], "name": r["name"], "unit": r["unit"],
            "used": used, "available": r["available_capacity"],
            "binding": binding, "shadow_price": shadow_price,
        })

    objective_value = makespan_var.solution_value() if makespan_var is not None else objective_fn.Value()

    return {
        "verdict": "solved",
        "solver_status": "optimal",
        "objective": objective,
        "objective_label": _OBJECTIVE_LABELS[objective],
        "objective_value": objective_value,
        "degenerate_note": degenerate_note,
        "products": product_rows,
        "machines": machine_rows,
        "resources": resource_rows,
        "quality_risk": quality_risk,
    }
