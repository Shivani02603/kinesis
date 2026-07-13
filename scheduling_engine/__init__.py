"""Scheduling Engine — exact constraint optimization, not model training.

"When does which order run on which machine" is a planning decision, not a
prediction: there is nothing to learn from history, there is a best answer to
compute given the orders, the machine sequence, and the rates. Google
OR-Tools' CP-SAT solver computes it exactly — the same philosophy as using
AutoGluon for training: a tested, principled engine instead of a hand-rolled
heuristic.

The one semantic judgment — which uploaded table is the open-orders list and
which is the routing/capacity sheet, and which columns mean what — goes to
the LLM with reasoning, then every claim is verified deterministically
(files/columns exist, quantities and rates parse as positive numbers, due
dates parse as dates, sequence numbers are unique). A wrong or unverifiable
identification is a hard error surfaced to the human, never a guess.
"""
