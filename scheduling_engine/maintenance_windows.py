"""Predicted machine-downtime windows for the scheduler, derived from the
Machine Health objective's own forecast — never a new threshold.

A window only appears when all three are real: this project already has a
completed maintenance training run, a confirmed graph link connects a
routing machine name to a monitored asset, and that asset's own signal
forecast genuinely crosses ITS OWN learned normal range (the exact
reference-band logic the Machine Health dashboard already uses). Missing any
one of those means no window for that machine — never a guessed one.
"""

import math
from datetime import datetime, timedelta

from pydantic import BaseModel

from decision_layer.narration import _reference_band
from understanding_engine.graph_store import GraphStore
from understanding_engine.llm_extraction import _call_tool_with_retry

_MATCH_SYSTEM_PROMPT = """You are matching machine names from a production-scheduling routing \
table against the real asset names in a factory's confirmed process graph — these two lists \
were extracted independently (one from an uploaded routing CSV, one from the understanding \
engine), so the same physical machine may be named slightly differently in each (e.g. "Furnace \
FCE-3" vs "Furnace 3").

For each routing machine name, decide which graph asset name (if any) refers to the SAME \
physical machine. Only match when you're confident they're the same real machine — a shared \
number, code, or unambiguous description. If no asset name is a plausible match, set asset_name \
to null for that machine. Never match two different machines just because both are furnaces or \
both are conveyors — the specific machine identity must line up, not just the category.

Call the tool exactly once, with one entry per routing machine name."""


class _MachineAssetMatch(BaseModel):
    machine_name: str
    asset_name: str | None


class _MachineAssetMapping(BaseModel):
    reasoning: str
    matches: list[_MachineAssetMatch]


def _match_machines_to_assets(routing_machines: list[str], asset_names: list[str]) -> dict[str, str]:
    if not asset_names or not routing_machines:
        return {}
    messages: list = [
        {"role": "system", "content": _MATCH_SYSTEM_PROMPT},
        {
            "role": "user",
            "content": (
                f"Routing machine names: {routing_machines!r}\n\n"
                f"Real asset names from the confirmed graph: {asset_names!r}"
            ),
        },
    ]
    decision: _MachineAssetMapping = _call_tool_with_retry(
        "record_machine_asset_matches",
        "Record which confirmed graph asset (if any) each routing machine name refers to.",
        _MachineAssetMapping,
        messages,
    )  # type: ignore[assignment]

    valid_assets = set(asset_names)
    return {
        m.machine_name: m.asset_name
        for m in decision.matches
        if m.asset_name is not None and m.asset_name in valid_assets
    }


def merge_windows(windows: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Coalesce a machine's windows into one interval per contiguous span.

    One asset usually carries several signals (vibration AND temperature on the same
    furnace), and each is checked for a forecast breach independently — so the same
    hours can be produced more than once. Handed to CP-SAT as separate fixed intervals
    they enter the same add_no_overlap constraint and conflict with EACH OTHER, which
    makes the whole schedule infeasible no matter what the orders look like (observed:
    two identical (0, 1) windows on one furnace). The machine is simply unavailable for
    the union of those hours, so the union is what the solver must be given.
    """
    cleaned = sorted((s, e) for s, e in windows if e > s)
    if not cleaned:
        return []
    merged = [cleaned[0]]
    for start, end in cleaned[1:]:
        last_start, last_end = merged[-1]
        if start <= last_end:  # overlapping or touching
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))
    return merged


def find_maintenance_windows(
    store: GraphStore,
    project_id: str,
    routing_machines: list[str],
    maintenance_result: dict | None,
    schedule_start: datetime,
) -> dict[str, list[tuple[int, int]]]:
    """machine_name -> list of (start_hour, end_hour) windows, hours relative
    to schedule_start, where that machine is predicted to be unavailable.
    Empty wherever there's no maintenance run, no graph link, or no breach."""
    if not maintenance_result:
        return {}
    series_by_signal = {s["item_id"]: s for s in maintenance_result.get("series", []) if s.get("item_id")}
    if not series_by_signal:
        return {}

    signals_by_asset = store.signals_by_asset(project_id)
    if not signals_by_asset:
        return {}

    machine_to_asset = _match_machines_to_assets(routing_machines, list(signals_by_asset.keys()))

    windows: dict[str, list[tuple[int, int]]] = {}
    for machine, asset in machine_to_asset.items():
        breach_ranges: list[tuple[datetime, datetime]] = []
        for signal_name in signals_by_asset.get(asset, []):
            series = series_by_signal.get(signal_name)
            if not series:
                continue
            history_values = [p["value"] for p in series.get("history", []) if p.get("value") is not None]
            # Same minimum-history bar as the dashboard's own deviation check —
            # too few points and a "normal range" isn't a real learned fact yet.
            if len(history_values) < 5:
                continue
            lo, hi, _ = _reference_band(history_values)

            breach_start: datetime | None = None
            last_ts: datetime | None = None
            for point in series.get("forecast", []):
                ts = datetime.fromisoformat(point["timestamp"])
                last_ts = ts
                value = point.get("mean")
                is_breach = value is not None and (value < lo or value > hi)
                if is_breach and breach_start is None:
                    breach_start = ts
                elif not is_breach and breach_start is not None:
                    breach_ranges.append((breach_start, ts))
                    breach_start = None
            if breach_start is not None and last_ts is not None:
                breach_ranges.append((breach_start, last_ts + timedelta(hours=1)))

        if breach_ranges:
            hour_windows = []
            for s, e in breach_ranges:
                start_h = (s - schedule_start).total_seconds() / 3600
                end_h = (e - schedule_start).total_seconds() / 3600
                # A breach that finished before this plan even begins says nothing about
                # this plan. Clamping it to (0, 1) — which is what taking max(0, …) and
                # max(1, …) on a negative offset does — silently turned every stale
                # forecast into "this machine is down in the plan's first hour", on every
                # machine at once. Drop it instead; only a window that actually reaches
                # into the horizon is a constraint, and one straddling the start is
                # clamped to begin at 0.
                if end_h <= 0:
                    continue
                hour_windows.append((max(0, math.floor(start_h)), math.ceil(end_h)))
            merged = merge_windows(hour_windows)
            if merged:
                windows[machine] = merged
    return windows
