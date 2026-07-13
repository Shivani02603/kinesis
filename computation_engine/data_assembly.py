"""Graph-aware data assembly — the one step AutoGluon cannot do for us.

AutoGluon sees a single dataframe; it has no idea that FCE-03_TEMP's values
live in one file's column while the asset it measures was defined in another
file entirely. Walking source_reference links from the confirmed graph and
producing that dataframe is this module's whole job. Generic preprocessing
(missing values, encodings, frequency regularization) is deliberately NOT
done here — AutoGluon handles it.

Every judgment here is a deterministic data fact:
- the timestamp column is the column whose every non-empty value parses as a
  datetime — none found or more than one found is an error surfaced to the
  human, never a guess between candidates;
- target values must parse as numbers — unparseable values are reported with
  a count, never silently dropped.
"""

from dataclasses import dataclass
from pathlib import Path

import pandas as pd


@dataclass
class AssembledData:
    frame: pd.DataFrame  # long format: item_id, timestamp, target
    timestamp_columns: dict[str, str | None]  # file -> timestamp column (None: file has no time axis)
    per_signal_rows: dict[str, int]
    excluded_signals: dict[str, str] = None  # type: ignore[assignment]  # signal_name -> why excluded

    def __post_init__(self):
        if self.excluded_signals is None:
            self.excluded_signals = {}


def _has_regular_frequency(timestamps: pd.Series) -> bool:
    """A real, deterministic fact: do these real timestamps fall on an evenly
    spaced cadence? Forecasting one item's own values over time requires that;
    a signal sampled at irregular, event-driven moments (e.g. one row per
    order, whenever an order happens to be placed) is not the same kind of
    time series and cannot be forecast alongside one that is — mixing them in
    one frame is what silently breaks AutoGluon's own frequency inference."""
    ts = pd.Series(sorted(timestamps.unique()))
    if len(ts) < 3:
        return False
    diffs = ts.diff().dropna()
    if diffs.empty:
        return False
    modal = diffs.mode()
    if modal.empty:
        return False
    # Regular means the gap between consecutive readings is the same value
    # for the large majority of the series — real sensor/sales logs have
    # occasional missed samples, genuine event logs do not have a majority
    # gap at all.
    matches = (diffs == modal.iloc[0]).mean()
    return matches >= 0.8


def _find_timestamp_column(df: pd.DataFrame, filename: str) -> str | None:
    """None means the file simply has no time axis (a routing sheet, a static
    parameter table) — a deterministic fact the caller handles by excluding
    that file's signals from forecasting, not by crashing the run. Ambiguity
    (multiple full-datetime columns) stays a hard error: that file DOES have
    time axes and silently guessing between them would be wrong."""
    candidates = []
    for col in df.columns:
        series = df[col].dropna().astype(str).str.strip()
        series = series[series != ""]
        if series.empty or not series.dtype == object:
            continue
        # Numeric-looking columns are excluded up front: pandas would happily
        # interpret bare numbers as epoch offsets, which is not evidence the
        # column holds timestamps.
        if pd.to_numeric(series, errors="coerce").notna().all():
            continue
        parsed = pd.to_datetime(series, errors="coerce", format="mixed")
        if parsed.notna().all():
            candidates.append(col)
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        return None
    raise ValueError(
        f"{filename}: multiple columns parse fully as datetimes ({candidates!r}) — "
        "ambiguous which one is the time axis; needs human clarification, not a guess"
    )


def assemble_forecasting_frame(upload_dir: Path, supporting_signals: list[dict]) -> AssembledData:
    """One long dataframe (item_id, timestamp, target) from every supporting
    signal's real file/column, ready for AutoGluon's TimeSeriesDataFrame.

    Only signals sampled on a genuinely regular cadence are included — a
    signal recorded once per order (whenever an order happens to occur) has
    no true "frequency" and would otherwise break AutoGluon's frequency
    inference the moment it's combined with a real daily/hourly log in the
    same frame. Irregular signals are dropped with the reason recorded, never
    silently forced into a shape they don't have.
    """
    pieces = []
    timestamp_columns: dict[str, str] = {}
    per_signal_rows: dict[str, int] = {}
    excluded_signals: dict[str, str] = {}

    for s in supporting_signals:
        file_path = upload_dir / s["source_file"]
        df = pd.read_csv(file_path)
        if s["source_file"] not in timestamp_columns:
            timestamp_columns[s["source_file"]] = _find_timestamp_column(df, s["source_file"])
        ts_col = timestamp_columns[s["source_file"]]
        if ts_col is None:
            excluded_signals[s["signal_name"]] = (
                f"{s['source_file']!r} has no column that parses as datetimes — a static "
                "table (e.g. a routing/capacity sheet) has no time axis, so this signal "
                "cannot be modeled as behavior over time"
            )
            continue

        target = pd.to_numeric(df[s["source_column"]], errors="coerce")
        non_null = df[s["source_column"]].notna().sum()
        bad = int(target.isna().sum() - df[s["source_column"]].isna().sum())
        if bad > 0:
            bad_fraction = bad / non_null if non_null else 1.0
            if bad_fraction >= 0.3:
                # Mostly or entirely non-numeric (e.g. "yes"/"no", a region name) — this
                # was never a measurable quantity to begin with, a categorical column
                # relevance judgment mistakenly called forecastable evidence. That is a
                # deterministic fact about the data, so exclude it, don't crash the run.
                excluded_signals[s["signal_name"]] = (
                    f"column {s['source_column']!r} in {s['source_file']!r} is not numeric "
                    f"({bad} of {non_null} values aren't numbers) — not a measurable quantity, "
                    "cannot be forecast"
                )
                continue
            # A small minority of bad values in an otherwise-numeric column is a genuine
            # data-quality issue worth surfacing to a human, not something to paper over.
            raise ValueError(
                f"{s['source_file']}: column {s['source_column']!r} has {bad} value(s) that are "
                "not numbers — refusing to silently drop them; the source data needs review"
            )

        piece = pd.DataFrame(
            {
                "item_id": s["signal_name"],
                "timestamp": pd.to_datetime(df[ts_col], format="mixed"),
                "target": target,
            }
        ).dropna(subset=["target"])

        if not _has_regular_frequency(piece["timestamp"]):
            excluded_signals[s["signal_name"]] = (
                f"recorded at irregular intervals in {s['source_file']!r} (e.g. one row per event, "
                "not a fixed cadence) — cannot be forecast as a time series"
            )
            continue

        per_signal_rows[s["signal_name"]] = len(piece)
        pieces.append(piece)

    if not pieces:
        raise ValueError(
            "None of the relevant signals are sampled on a regular cadence, so none can be "
            f"forecast as a time series: {excluded_signals}"
        )

    frame = pd.concat(pieces, ignore_index=True).sort_values(["item_id", "timestamp"])
    return AssembledData(
        frame=frame, timestamp_columns=timestamp_columns,
        per_signal_rows=per_signal_rows, excluded_signals=excluded_signals,
    )


def load_labeled_table(upload_dir: Path, label_file: str) -> pd.DataFrame:
    """The supervised path trains on the label file's own rows as examples.
    Joining sensor readings onto label events by time window is a later,
    separate enrichment step — not silently improvised here."""
    return pd.read_csv(upload_dir / label_file)
