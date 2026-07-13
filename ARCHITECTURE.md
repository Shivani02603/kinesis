# Kinesis — System Architecture

Open this file in VS Code and use your Mermaid preview extension (right-click inside any
```mermaid``` block → "Open Preview", or `Ctrl+Shift+V` for the full markdown preview) to
render each diagram below.

Four gated layers. Nothing hardcoded, nothing fabricated — every LLM judgment is
deterministically re-verified before it's trusted, and every business objective is gated by
the one before it (a file isn't usable until a human confirms the graph; an objective isn't
trainable until Feasibility confirms real data supports it).

---

## 1. Pipeline overview

```mermaid
flowchart LR
    U[/Raw factory files:<br/>csv, txt, pdf/] --> A[Layer A<br/>Understanding Engine]
    A --> G[(Confirmed<br/>Knowledge Graph)]
    G --> B[Layer B<br/>Feasibility Engine]
    B -- attemptable --> C[Layer C<br/>Computation Engine]
    B -- not attemptable --> R([Rejected — reason<br/>shown verbatim])
    C --> D[Layer D<br/>Decision Layer]
    D --> DB[(Dashboard Card)]

    classDef layerA fill:#EEEBF5,stroke:#6B5B95,stroke-width:2px,color:#2c2440
    classDef layerB fill:#E4F2EF,stroke:#1F7A6C,stroke-width:2px,color:#123d35
    classDef layerC fill:#E7EEF8,stroke:#1E5AA8,stroke-width:2px,color:#0d2c4f
    classDef layerD fill:#FCEFDC,stroke:#9A5B00,stroke-width:2px,color:#4a2c00
    class A layerA
    class B layerB
    class C layerC
    class D layerD
```

---

## 2. Layer A — Understanding Engine

Raw documents → a confirmed, versioned knowledge graph. No per-industry or per-client code —
the same pipeline runs whether the source is a steel plant or a bottling line.

```mermaid
flowchart TD
    A1[Raw files: csv / txt / pdf] --> A2[Parse to normalized text]
    A2 --> A3[LLM extraction<br/>forced tool call + Pydantic schema]
    A3 --> A4{Schema valid?}
    A4 -- no, re-prompt --> A3
    A4 -- yes --> A5[Entity resolution]
    A5 --> A6[Exact-name match<br/>cheap, certain, no LLM]
    A5 --> A7[LLM duplicate candidates<br/>reasoning written before the list]
    A6 --> A8{Ambiguous merge?}
    A7 --> A8
    A8 -- yes --> A9[Human review queue]
    A8 -- no --> A10[Neo4j graph assembly<br/>MERGE, project-scoped]
    A9 --> A10
    A10 --> A11[Structural validation<br/>stage gaps, orphan signals]
    A11 --> A12([Human confirms version])
```

**Real bug this caught:** the duplicate-candidate LLM call returned zero pairs for five genuine
duplicates (`MX1_VIB` vs. `"Mixer MX-1 condition-monitoring vibration"` — same sensor, two
names) because the response schema had no `reasoning` field ahead of the `pairs` list. Moving
`reasoning` to the first field — forcing the exhaustive comparison to be written down before the
list is closed — took the same inputs from 0 pairs to the correct 5.

---

## 3. Layer B — Feasibility Engine

One function decides relevance for every objective, on every dataset — no per-objective code.

```mermaid
flowchart TD
    B1[Objective string, e.g. maintenance] --> B2[Structural check:<br/>signals with real source_reference]
    B2 --> B3[LLM relevance judgment:<br/>which signals matter for THIS objective]
    B3 --> B4[Deterministic verification:<br/>every returned id must exist in candidates]
    B4 --> B5{Attemptable?}
    B5 -- yes --> B6([supporting_signals list])
    B5 -- no --> B7([Plain-language reason,<br/>shown to the user verbatim])
```

---

## 4. Layer C — Computation Engine

Decides *what kind* of model the data supports, then hands modeling entirely to AutoGluon or
OR-Tools — this layer shapes inputs and reports outputs, never hand-rolls a model.

```mermaid
flowchart TD
    C1[supporting_signals + file catalog<br/>real headers + sampled values] --> C2[Task detection LLM]
    C2 --> C3{task_type}

    C3 -- supervised --> C4[Verify label file / column / kind<br/>quantity vs category]
    C4 --> C5[AutoGluon TabularPredictor.fit]
    C5 --> C6([leaderboard + feature_importance<br/>+ predictions for pending rows])

    C3 -- forecasting --> C7[Data assembly:<br/>regular-frequency + numeric checks]
    C7 --> C8[AutoGluon TimeSeriesPredictor.fit]
    C8 --> C9([per-signal history<br/>+ quantile forecast q10/q50/q90])

    C3 -- scheduling --> C10{objective itself<br/>== scheduling?}
    C10 -- no --> C11([Rejected: structural guard —<br/>data shape isn't the objective])
    C10 -- yes --> C12[OR-Tools CP-SAT solve<br/>no training at all]
    C12 --> C13([machine-by-machine plan,<br/>verified optimal])

    C3 -- not_supportable --> C14([Run fails,<br/>reasoning shown verbatim])
```

**Real output for "maintenance"** (`task_type: forecasting`, `shortest_series_length: 336`):

| Model | WQL score | Fit time | Predict time |
|---|---|---|---|
| **WeightedEnsemble** ← selected | −0.0328 | 1.16s | 7.39s |
| ETS | −0.0328 | 0.02s | 6.77s |
| Chronos2 | −0.0399 | 17.25s | 0.61s |
| Theta | −0.0484 | 0.05s | 0.10s |
| SeasonalNaive | −0.0598 | 0.03s | 17.5s |

---

## 5. Layer D — Decision Layer

Pure, deterministic Python — **no LLM call happens here.** Every sentence a business user reads
is arithmetic over numbers Layer C already computed.

```mermaid
flowchart TD
    D1[Training run JSON] --> D3[summarize_* function<br/>pure Python, no LLM]
    D2[Human-entered settings<br/>on-hand stock, supplier lead time] --> D3
    D3 --> D4[Reference-band split:<br/>first 60% of history vs recent period]
    D4 --> D5[Count out-of-band readings<br/>+ % change vs baseline]
    D5 --> D6([Card: objective, status,<br/>headline, facts, chart data])
    D6 --> D7[Rendered directly on dashboard —<br/>no further transformation]
```

**Real card produced** (status `watch`, headline *"3 of 4 machines have drifted from their
normal range."*):

| Signal | Status | Outside normal | Learned normal range | vs. baseline |
|---|---|---|---|---|
| LB3_VIB | Watch | 57 / 68 | 1.38 – 1.85 | +25%, climbing |
| FL4_VIB | Watch | 50 / 68 | 1.25 – 1.79 | +24%, climbing |
| CP2_VIB | Watch | 18 / 68 | 1.14 – 1.54 | −1% |
| MX1_VIB | OK | 9 / 68 | 1.00 – 1.42 | +1% |

---

## 6. End-to-end trace — one real signal through all four layers

`MX1_VIB`, the vibration reading on Mixer MX-1, moving through the entire pipeline exactly as
it happened for this run.

```mermaid
sequenceDiagram
    participant F as sensor_readings.csv
    participant A as Layer A
    participant B as Layer B
    participant C as Layer C (AutoGluon)
    participant D as Layer D
    participant UI as Dashboard

    F->>A: MX1_VIB, 336 hourly readings
    A->>A: Extract Signal + MEASURES -> Mixer MX-1
    A->>B: Confirmed graph
    B->>B: Judge relevant to "maintenance"
    B->>C: supporting_signals includes MX1_VIB (336 rows)
    C->>C: task_type = forecasting
    C->>C: TimeSeriesPredictor.fit -> WeightedEnsemble wins
    C->>D: forecast mean 1.21, q10 1.00, q90 1.42
    D->>D: 9 of 68 recent readings outside band, +1% vs baseline
    D->>UI: status "ok" + headline fact
    UI-->>UI: Stat tile + deviation bar + forecast chart render
```

---

## Guardrails enforced structurally (not just documented)

- **Verify every LLM decision** — a named label column, a chosen signal id, a proposed duplicate:
  all re-checked deterministically against real data before use.
- **Reasoning-first schemas** — structured-output models fill fields in declaration order, so every
  decision schema puts `reasoning` before the decision fields it leads to.
- **B gates C** — Computation never runs for an objective Feasibility hasn't confirmed attemptable.
- **Human-in-the-loop, always** — ambiguous merges, structural gaps, orphan signals are queued for a
  person, never auto-resolved.
- **Immutable graph versions** — training only ever runs against a confirmed version.
- **Zero hardcoded thresholds** — "normal" is always a signal's own learned quantile band, never a
  fixed number reused across clients or industries.
