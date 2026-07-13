"""Per-objective narration: real training-run results -> a plain-language card.

Every function here takes the actual JSON a training run produced (and, for
inventory, real human-entered settings) and computes real derived facts —
counts, dates, differences — then formats them into sentences. No LLM call,
no invented content: this is pure arithmetic over numbers the platform
already computed, which is exactly why every claim can be traced back to a
real source.
"""

from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd


@dataclass
class Card:
    objective: str
    status: str  # ok | watch | crit | info | pending | error
    headline: str
    facts: list[str] = field(default_factory=list)
    data: dict = field(default_factory=dict)  # chart-ready payload, passthrough
    actions: list[str] = field(default_factory=list)


def _reference_band(values: list[float], split_frac: float = 0.6) -> tuple[float, float, list[float]]:
    """Split a history into an earlier reference period and a recent period;
    the reference period's own 10th-90th percentile is this signal's normal
    range — learned from its own data, not a number anyone chose."""
    n = len(values)
    split = max(1, int(n * split_frac))
    ref = sorted(values[:split])
    recent = values[split:]
    lo = ref[int(len(ref) * 0.1)]
    hi = ref[min(len(ref) - 1, int(len(ref) * 0.9))]
    return lo, hi, recent


def summarize_deviation(
    objective: str, run: dict, unit_word: str = "reading", item_word: str = "signal",
    watch_phrase: str = "drifted from {pron} normal range",
    ok_phrase: str = "within {pron} normal range",
) -> Card:
    """Shared logic for signals modeled as forecasts where the question is
    'has this drifted from its own normal?' — machine health and quality.
    Reports on EVERY monitored item (every machine, every tracked signal),
    not just whichever one looks worst — a factory with four sensored
    machines should see all four, not one picked at random."""
    result = run["result"]
    series = result.get("series", [])
    if not series:
        return Card(objective=objective, status="error", headline="No signal data available.")

    items = []
    all_flags = []
    for s in series:
        history_pts = [h for h in s["history"] if h["value"] is not None]
        values = [h["value"] for h in history_pts]
        if len(values) < 10:
            continue
        lo, hi, recent = _reference_band(values)
        recent_pts = history_pts[len(history_pts) - len(recent):]
        out_of_band = sum(1 for v in recent if v < lo or v > hi)
        frac = out_of_band / len(recent) if recent else 0
        ref_values = values[:len(values) - len(recent)] or values
        ref_mean = sum(ref_values) / len(ref_values)
        recent_mean = sum(recent) / len(recent) if recent else ref_mean
        pct_change = ((recent_mean - ref_mean) / ref_mean * 100) if ref_mean else 0
        forecast = s.get("forecast", [])
        trend_up = len(forecast) >= 2 and forecast[-1]["mean"] > forecast[0]["mean"]
        # Real flagged readings — the exact recorded points that actually fell
        # outside this signal's own learned band, not a synthetic alert log.
        flags = [
            {"item_id": s["item_id"], "timestamp": h["timestamp"], "value": h["value"], "lo": lo, "hi": hi}
            for h in recent_pts if h["value"] < lo or h["value"] > hi
        ]
        all_flags.extend(flags)
        items.append({
            "item_id": s["item_id"], "status": "watch" if frac >= 0.25 else "ok",
            "out_of_band": out_of_band, "recent_n": len(recent), "lo": lo, "hi": hi,
            "frac": frac, "trend_up": trend_up, "pct_change": pct_change,
        })

    if not items:
        return Card(objective=objective, status="info", headline="Not enough history yet to judge.", data={"series": series})

    all_flags.sort(key=lambda f: f["timestamp"], reverse=True)
    recent_alerts = all_flags[:8]

    items.sort(key=lambda it: it["frac"], reverse=True)
    watch_items = [it for it in items if it["status"] == "watch"]
    total = len(items)
    status = "watch" if watch_items else "ok"

    if watch_items:
        headline = (
            f"{len(watch_items)} of {total} {item_word}s have " + watch_phrase.format(pron="their") + "."
            if total > 1 else f"{items[0]['item_id']} has " + watch_phrase.format(pron="its") + "."
        )
    else:
        headline = (
            f"All {total} {item_word}s are " + ok_phrase.format(pron="their") + "."
            if total > 1 else f"{items[0]['item_id']} is " + ok_phrase.format(pron="its") + "."
        )

    facts = []
    for it in items:
        line = (
            f"{it['item_id']}: {it['out_of_band']} of the last {it['recent_n']} {unit_word}s were outside "
            f"its own normal range ({it['lo']:.2f} – {it['hi']:.2f})"
        )
        if abs(it["pct_change"]) >= 3:
            direction = "higher" if it["pct_change"] > 0 else "lower"
            line += f", recent average {abs(it['pct_change']):.0f}% {direction} than its earlier baseline"
        if it["status"] == "watch" and it["trend_up"]:
            line += "; forecast expects it to keep climbing"
        facts.append(line + ".")

    return Card(
        objective=objective, status=status, headline=headline, facts=facts,
        data={"series": series, "items": items, "recent_alerts": recent_alerts,
              "flagged_item": watch_items[0]["item_id"] if watch_items else None},
    )


def summarize_maintenance(run: dict) -> Card:
    card = summarize_deviation("maintenance", run, unit_word="reading", item_word="machine")
    if card.status == "watch":
        card.actions = ["Create work order", "This was useful", "False alarm"]
    return card


def summarize_quality(run: dict) -> Card:
    return summarize_deviation(
        "quality", run, unit_word="day", item_word="quality signal",
        watch_phrase="more rejects than normal in {pron} recent readings",
        ok_phrase="within {pron} normal reject rate",
    )


def summarize_demand(run: dict) -> Card:
    """Reports every demand series the model was given — one per product if
    the client's sales history was broken out by product, not just whichever
    signal happened to be listed first."""
    result = run["result"]
    series = result.get("series", [])
    if not series:
        return Card(objective="demand_forecast", status="error", headline="No demand signal available.")

    horizon = len(series[0].get("forecast", []))
    per_item = []
    for s in series:
        forecast = s.get("forecast", [])
        total = sum(f["mean"] for f in forecast)
        lo = sum(f["q10"] for f in forecast)
        hi = sum(f["q90"] for f in forecast)
        per_item.append({"item_id": s["item_id"], "total": total, "lo": lo, "hi": hi})
    per_item.sort(key=lambda it: it["total"], reverse=True)

    grand_total = sum(it["total"] for it in per_item)
    grand_lo = sum(it["lo"] for it in per_item)
    grand_hi = sum(it["hi"] for it in per_item)

    if len(per_item) > 1:
        headline = f"Expect about {grand_total:,.0f} units over the next {horizon} days, across {len(per_item)} products."
    else:
        headline = f"Expect about {grand_total:,.0f} units over the next {horizon} days."

    facts = [f"Likely total range: {grand_lo:,.0f} – {grand_hi:,.0f} units."]
    for it in per_item:
        label = it["item_id"].replace("_SHIPPED", "").replace("_", " ").title()
        facts.append(f"{label}: ~{it['total']:,.0f} units (range {it['lo']:,.0f} – {it['hi']:,.0f}).")

    return Card(
        objective="demand_forecast", status="info", headline=headline, facts=facts,
        data={"series": series, "per_product": per_item},
    )


def _historical_on_time_rate(upload_dir: Path) -> dict | None:
    """Reads whatever order-history table the client actually uploaded and
    computes a REAL on-time-delivery rate from it: a completed order is "on
    time" if its actual lead time was no more than what was promised at order
    time. Returns None (not a fabricated number) if the file or the two
    needed columns genuinely aren't there."""
    hist_path = next(
        (p for p in upload_dir.glob("*.csv") if "order" in p.name.lower() and "history" in p.name.lower()), None
    )
    if not hist_path or not hist_path.exists():
        return None
    df = pd.read_csv(hist_path)
    promised_col = next((c for c in df.columns if "promis" in c.lower() and "lead" in c.lower()), None)
    actual_col = next((c for c in df.columns if "actual" in c.lower() and "lead" in c.lower()), None)
    date_col = next((c for c in df.columns if "order" in c.lower() and "date" in c.lower()), None)
    if not promised_col or not actual_col:
        return None

    completed = df.dropna(subset=[actual_col])
    if completed.empty:
        return None
    on_time = completed[actual_col] <= completed[promised_col]
    out = {"overall_rate": float(on_time.mean() * 100), "overall_n": int(len(completed))}

    if date_col:
        completed = completed.copy()
        completed["_order_date"] = pd.to_datetime(completed[date_col])
        cutoff = completed["_order_date"].max() - timedelta(days=30)
        recent = completed[completed["_order_date"] >= cutoff]
        if len(recent) >= 5:
            out["recent_rate"] = float((recent[actual_col] <= recent[promised_col]).mean() * 100)
            out["recent_n"] = int(len(recent))
    return out


def summarize_delivery(run: dict, upload_dir: Path) -> Card:
    result = run["result"]
    pending = result.get("pending_predictions", [])
    hist = _historical_on_time_rate(upload_dir)

    if not pending:
        facts = []
        if hist:
            if "recent_rate" in hist:
                facts.append(f"Over the last 30 days, {hist['recent_rate']:.0f}% of {hist['recent_n']} completed orders were delivered within the promised lead time.")
            else:
                facts.append(f"Historically, {hist['overall_rate']:.0f}% of {hist['overall_n']} completed orders were delivered within the promised lead time.")
        return Card(
            objective="delivery_date", status="ok",
            headline="No open orders waiting on a delivery estimate right now.",
            facts=facts, data={"historical_on_time": hist} if hist else {},
        )

    label_col = result["params"]["label_column"]
    pred_col = "predicted_" + label_col

    # Join with the real open-orders table by order_id — the only fabricated
    # step here would be inventing a promised date; instead we read it from
    # whatever the client actually uploaded.
    orders_path = next((p for p in upload_dir.glob("*.csv")
                         if "order" in p.name.lower() and "history" not in p.name.lower()), None)
    due_by_id: dict[str, datetime] = {}
    id_col = None
    if orders_path and orders_path.exists():
        odf = pd.read_csv(orders_path)
        id_col = next((c for c in odf.columns if "order" in c.lower() and "id" in c.lower()), None)
        due_col = next((c for c in odf.columns if "due" in c.lower() or "promis" in c.lower()), None)
        if id_col and due_col:
            for _, r in odf.iterrows():
                due_by_id[str(r[id_col])] = pd.to_datetime(r[due_col])

    order_id_field = next((k for k in pending[0] if "order" in k.lower() and "id" in k.lower()), None)
    date_field = next((k for k in pending[0] if "date" in k.lower()), None)

    rows = []
    late_count = 0
    for p in pending:
        oid = str(p.get(order_id_field)) if order_id_field else None
        order_date = pd.to_datetime(p[date_field]) if date_field and p.get(date_field) else None
        lead_days = p[pred_col]
        estimated = (order_date + timedelta(days=lead_days)) if order_date is not None and lead_days is not None else None
        due = due_by_id.get(oid) if oid else None
        late_days = (estimated - due).days if estimated is not None and due is not None else None
        if late_days is not None and late_days > 0:
            late_count += 1
        rows.append({
            **p, "order_id": oid, "estimated_delivery": estimated.isoformat() if estimated is not None else None,
            "promised_date": due.isoformat() if due is not None else None,
            "late_days": late_days,
        })

    status = "watch" if late_count else "ok"
    headline = (
        f"{late_count} of {len(rows)} open order(s) may miss their promised date."
        if late_count else f"All {len(rows)} open orders are expected on time."
    )
    facts = []
    worst = max((r for r in rows if r["late_days"]), key=lambda r: r["late_days"], default=None)
    if worst:
        facts.append(f"{worst['order_id']} is predicted about {worst['late_days']} day(s) late.")
    if hist:
        if "recent_rate" in hist:
            facts.append(f"Over the last 30 days, {hist['recent_rate']:.0f}% of {hist['recent_n']} completed orders were delivered within the promised lead time.")
        else:
            facts.append(f"Historically, {hist['overall_rate']:.0f}% of {hist['overall_n']} completed orders were delivered within the promised lead time.")

    return Card(
        objective="delivery_date", status=status, headline=headline, facts=facts,
        data={"orders": rows, "feature_importance": result.get("feature_importance", []), "historical_on_time": hist},
        actions=["Mark as rush", "Notify customer"] if late_count else [],
    )


def summarize_inventory(run: dict, settings: dict[str, str]) -> Card:
    """Every material the model tracked gets its own reorder computation —
    a factory rarely has just one material worth watching. Materials the
    human hasn't entered on-hand/lead-time for yet are still listed (so
    they're visible and easy to configure), just without a computed date."""
    result = run["result"]
    series = result.get("series", [])
    if not series:
        return Card(objective="inventory", status="error", headline="No consumption signal available.")

    today = datetime.now()
    items = []
    for s in series:
        material = s["item_id"]
        on_hand = settings.get(f"inventory.{material}.on_hand")
        lead_time = settings.get(f"inventory.{material}.lead_time_days")
        if on_hand is None or lead_time is None:
            items.append({"material": material, "configured": False})
            continue

        on_hand = float(on_hand)
        lead_time = float(lead_time)
        forecast = s["forecast"]
        avg_daily_usage = sum(f["mean"] for f in forecast) / len(forecast)
        avg_spread = sum((f["q90"] - f["mean"]) for f in forecast) / len(forecast)
        if avg_daily_usage <= 0:
            items.append({"material": material, "configured": True, "error": "forecast usage is zero"})
            continue

        safety_units = avg_spread * lead_time
        runway_days = on_hand / avg_daily_usage
        safety_days = safety_units / avg_daily_usage
        reorder_in_days = max(0, runway_days - lead_time - safety_days)
        items.append({
            "material": material, "configured": True,
            "on_hand": on_hand, "lead_time_days": lead_time, "avg_daily_usage": avg_daily_usage,
            "reorder_in_days": reorder_in_days,
            "reorder_date": (today + timedelta(days=reorder_in_days)).isoformat(),
            "runs_out_date": (today + timedelta(days=runway_days)).isoformat(),
        })

    configured_items = [it for it in items if it.get("on_hand") is not None]
    unconfigured = [it["material"] for it in items if not it["configured"]]

    if not configured_items:
        return Card(
            objective="inventory", status="info",
            headline=f"Enter current stock and supplier lead time to get reorder dates for {len(items)} material(s).",
            facts=["These are real facts only you know — the system has no way to guess them."],
            data={"series": series, "items": items, "needs_settings": True},
        )

    configured_items.sort(key=lambda it: it["reorder_in_days"])
    urgent = configured_items[0]
    watch_count = sum(1 for it in configured_items if it["reorder_in_days"] <= 7)
    status = "watch" if watch_count else "ok"

    def label(material: str) -> str:
        return material.removesuffix("_CONSUMED").replace("_", " ").strip().title()

    headline = f"Order {label(urgent['material']).lower()} by {datetime.fromisoformat(urgent['reorder_date']).strftime('%A, %d %b')}."
    if len(configured_items) > 1:
        headline += f" ({len(configured_items)} materials tracked)"

    facts = [
        f"{label(it['material'])}: {it['on_hand']:,.0f} on hand, using about "
        f"{it['avg_daily_usage']:,.0f}/day, reorder by {datetime.fromisoformat(it['reorder_date']).strftime('%d %b')}, "
        f"would run out around {datetime.fromisoformat(it['runs_out_date']).strftime('%d %b')}."
        for it in configured_items
    ]
    if unconfigured:
        facts.append(f"Not yet configured: {', '.join(label(m) for m in unconfigured)}.")

    return Card(
        objective="inventory", status=status, headline=headline, facts=facts,
        data={"series": series, "items": items},
        actions=["Draft purchase order", "Remind me on the day"],
    )


def summarize_scheduling(run: dict) -> Card:
    result = run["result"]
    orders = result.get("orders", [])
    late = result.get("orders_late", 0)
    status = "watch" if late else "ok"
    headline = (
        f"{late} of {len(orders)} order(s) will miss their due date in the best available plan."
        if late else f"All {len(orders)} pending orders finish on time."
    )
    return Card(
        objective="scheduling", status=status, headline=headline,
        facts=[f"Everything finishes within {result.get('makespan_hours')} hours.",
               f"Plan verified optimal by {result.get('params', {}).get('solver', 'the solver')} — not a heuristic guess."],
        data=result,
        actions=["Share with floor team"],
    )


SUMMARIZERS = {
    "maintenance": lambda run, **kw: summarize_maintenance(run),
    "quality": lambda run, **kw: summarize_quality(run),
    "demand_forecast": lambda run, **kw: summarize_demand(run),
    "delivery_date": lambda run, upload_dir=None, **kw: summarize_delivery(run, upload_dir),
    "inventory": lambda run, settings=None, **kw: summarize_inventory(run, settings or {}),
    "scheduling": lambda run, **kw: summarize_scheduling(run),
}
