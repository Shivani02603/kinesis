"""Decision Layer (D) — turns real computed results into plain language.

Every sentence here is built from a number that was actually computed by B or
C — a real forecast value, a real predicted lead time, a real schedule
outcome, a real human-entered setting (stock on hand, supplier lead time).
Nothing is invented: if a fact needed to answer a question isn't available
yet (e.g. a supplier lead time was never entered), the honest response says
so and asks for it — it never substitutes a plausible-looking placeholder.
"""
