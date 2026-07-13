"""Computation Engine (C) — actual model training on the confirmed graph's data.

Runs only after the Understanding Engine (A) has a confirmed graph version and
the Feasibility Engine (B) has said the objective is worth attempting.

Division of labour, agreed explicitly:
- This package's own code does ONLY what requires graph knowledge — deciding
  which task type the available data genuinely supports (LLM reasoning over
  data facts), and assembling real values out of the files/columns the graph's
  source_reference fields point at.
- Everything that is generic data science — missing values, encodings,
  datetime features, model selection, hyperparameters — is AutoGluon's job.
  We never hand-roll a heuristic AutoGluon already handles better.
"""
