"""Planning Engine — production-mix / capacity-allocation optimization.

"Given what a company can produce, sell, and how much capacity it has, how
much of each product should it make to maximize profit?" is a linear program,
not a prediction: there is a provably best answer given the numbers, not a
pattern to learn from history.

Unlike the Scheduling Engine, nothing here is extracted from an upload — a
Company Admin enters and edits the products, resources, and consumption
figures directly, and they persist across "generate plan" runs. The solver
(OR-Tools' GLOP linear solver) never just reports "infeasible" or "unbounded"
without saying why: both failure modes are checked in closed form before the
solver even runs, so every verdict names the exact resource or product that
caused it.
"""
