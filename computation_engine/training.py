"""AutoGluon training — model selection, preprocessing, and validation all
delegated to AutoGluon; this module only shapes inputs, runs the fit, and
reports what actually happened.

Honesty rules carried from the rest of the platform:
- Metrics are reported as AutoGluon measured them, never post-judged against
  a hardcoded "good enough" bar — whether a score is acceptable is the
  business user's call in the Decision Layer.
- The forecasting path's quantile band IS the deliverable: a normal range
  learned from each machine's own history. No threshold in this file.
- prediction_length is a visible modeling knob with a transparent default
  (a fifth of the shortest series, capped at 48 steps), recorded in the run's
  params so nothing about the setup is hidden.

AutoGluon imports live inside functions: they take seconds and pull heavy
dependencies, and the Understanding/Feasibility API must not pay that cost.
"""

import math
from pathlib import Path

import pandas as pd

from .data_assembly import AssembledData

_HISTORY_POINTS_IN_PAYLOAD = 168  # one week of hourly context for the chart
_QUANTILES = [0.1, 0.5, 0.9]


def _round(value: float | None, digits: int = 4) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    return round(float(value), digits)


def _leaderboard_records(leaderboard: pd.DataFrame) -> list[dict]:
    records = []
    for _, row in leaderboard.iterrows():
        records.append(
            {
                "model": row["model"],
                "score_val": _round(row.get("score_val")),
                "fit_time": _round(row.get("fit_time_marginal", row.get("fit_time")), 2),
                "predict_time": _round(row.get("pred_time_val"), 2),
            }
        )
    return records


def _why_model_won(leaderboard_records: list[dict], best_model: str) -> str | None:
    """A sentence built only from the real leaderboard numbers above — never an
    invented explanation of a model's internals. If AutoGluon didn't report a
    comparable runner-up (only one model, or missing scores), this is None and
    the UI shows nothing rather than a hollow sentence."""
    scored = [r for r in leaderboard_records if r["score_val"] is not None]
    winner = next((r for r in scored if r["model"] == best_model), None)
    if winner is None:
        return None
    runner_up = next((r for r in scored if r["model"] != best_model), None)
    if runner_up is None:
        return None

    parts = [
        f"{winner['model']} had the best validation score "
        f"({winner['score_val']} vs {runner_up['model']}'s {runner_up['score_val']})"
    ]
    wt, rt = winner.get("fit_time"), runner_up.get("fit_time")
    if wt is not None and rt is not None and rt > 0 and wt != rt:
        if wt < rt:
            pct = round((1 - wt / rt) * 100)
            if pct > 0:
                parts.append(f"and fit {pct}% faster")
        else:
            pct = round((wt / rt - 1) * 100)
            if pct > 0:
                parts.append(f"though it took {pct}% longer to fit")
    return " ".join(parts) + "."


def _dominant_freq(frame: "pd.DataFrame"):
    """The single most common gap between consecutive readings, as a pandas
    offset. AutoGluon needs a fixed cadence to fit a time-series model; the
    upstream regularity check only guarantees ~80% of gaps match, and appending
    live data after a break (history ends, then new rows resume) can leave a hole
    that makes AutoGluon's own stricter inference give up with 'frequency cannot
    be inferred'. Declaring the cadence ourselves and snapping to it fixes that."""
    gaps: list = []
    for _, g in frame.groupby("item_id"):
        ts = pd.Series(sorted(pd.to_datetime(g["timestamp"]).unique()))
        gaps.extend(ts.diff().dropna().tolist())
    if not gaps:
        return None
    modal = pd.Series(gaps).mode()
    if modal.empty:
        return None
    try:
        return pd.tseries.frequencies.to_offset(modal.iloc[0])
    except (ValueError, TypeError):
        return None


def train_forecasting(
    assembled: AssembledData,
    model_dir: Path,
    prediction_length: int | None = None,
    time_limit: int = 600,
) -> dict:
    from autogluon.timeseries import TimeSeriesDataFrame, TimeSeriesPredictor

    frame = assembled.frame
    shortest = int(frame.groupby("item_id").size().min())
    if prediction_length is None:
        prediction_length = max(1, min(48, shortest // 5))

    ts_data = TimeSeriesDataFrame.from_data_frame(
        frame, id_column="item_id", timestamp_column="timestamp"
    )
    # Snap every series onto one fixed cadence before fitting. convert_frequency
    # reindexes to a regular grid (gaps become NaN, which AutoGluon then imputes
    # with its own documented method) — so a hole from newly-appended live data no
    # longer breaks frequency inference. Guarded so an API/edge difference degrades
    # to the previous behaviour instead of failing worse.
    freq = _dominant_freq(frame)
    if freq is not None:
        try:
            ts_data = ts_data.convert_frequency(freq)
        except Exception:  # noqa: BLE001 — fall back to letting AutoGluon infer
            pass

    predictor = TimeSeriesPredictor(
        path=str(model_dir),
        prediction_length=prediction_length,
        quantile_levels=_QUANTILES,
        eval_metric="WQL",
        freq=freq.freqstr if freq is not None else None,
    )
    predictor.fit(ts_data, presets="medium_quality", time_limit=time_limit)

    leaderboard = predictor.leaderboard(ts_data)
    leaderboard_records = _leaderboard_records(leaderboard)
    predictions = predictor.predict(ts_data)

    series_payload = []
    for item_id in frame["item_id"].unique():
        history = frame[frame["item_id"] == item_id].tail(_HISTORY_POINTS_IN_PAYLOAD)
        item_preds = predictions.loc[item_id]
        series_payload.append(
            {
                "item_id": item_id,
                "history": [
                    {"timestamp": ts.isoformat(), "value": _round(v)}
                    for ts, v in zip(history["timestamp"], history["target"])
                ],
                "forecast": [
                    {
                        "timestamp": ts.isoformat(),
                        "mean": _round(row["mean"]),
                        "q10": _round(row["0.1"]),
                        "q50": _round(row["0.5"]),
                        "q90": _round(row["0.9"]),
                    }
                    for ts, row in item_preds.iterrows()
                ],
            }
        )

    return {
        "task_type": "forecasting",
        "best_model": predictor.model_best,
        "eval_metric": "WQL, shown negated per AutoGluon convention — closer to 0 is better, 0 is perfect",
        "leaderboard": leaderboard_records,
        "why_model_won": _why_model_won(leaderboard_records, predictor.model_best),
        "series": series_payload,
        "params": {
            "prediction_length": prediction_length,
            "quantile_levels": _QUANTILES,
            "time_limit_seconds": time_limit,
            "presets": "medium_quality",
            "shortest_series_length": shortest,
        },
    }


def _json_safe(value):
    if pd.isna(value):
        return None
    if hasattr(value, "isoformat"):
        return value.isoformat()
    if hasattr(value, "item"):  # numpy scalar (int64, float64, bool_) -> native Python
        return value.item()
    return value


def train_supervised(
    table: pd.DataFrame,
    label_column: str,
    label_kind: str,
    model_dir: Path,
    time_limit: int = 600,
) -> dict:
    from autogluon.tabular import TabularPredictor

    # A row whose label is blank is not missing data to clean up — it is a real,
    # not-yet-happened case (an order still in transit, its actual lead time
    # genuinely unknown yet). Those rows never enter training; they are exactly
    # what the trained model is then used to predict, since fabricating an
    # outcome for them would be inventing data the client doesn't have.
    is_pending = table[label_column].isna()
    train_table = table[~is_pending].reset_index(drop=True)
    pending_table = table[is_pending].reset_index(drop=True)

    if train_table.empty:
        raise ValueError(
            f"label column {label_column!r} has no completed rows to learn from — every row's "
            "outcome is still blank, there is nothing to train on yet"
        )

    # label_kind comes from task detection's reasoned judgment (verified against the
    # actual values): a quantity must be regression — AutoGluon's own inference sees a
    # handful of small integers (e.g. lead time in days) and wrongly calls it multiclass,
    # where being off by one day counts as fully wrong and unseen day-values can never
    # be predicted at all. A category keeps AutoGluon's inference (binary vs multiclass).
    problem_type = "regression" if label_kind == "quantity" else None
    predictor = TabularPredictor(label=label_column, problem_type=problem_type, path=str(model_dir))
    predictor.fit(train_table, presets="medium_quality", time_limit=time_limit)

    leaderboard = predictor.leaderboard()
    leaderboard_records = _leaderboard_records(leaderboard)
    importance = predictor.feature_importance(train_table)

    pending_predictions = []
    if not pending_table.empty:
        features = pending_table.drop(columns=[label_column])
        predicted = predictor.predict(features)
        for (_, row), pred in zip(pending_table.iterrows(), predicted):
            record = {col: _json_safe(val) for col, val in row.items() if col != label_column}
            record["predicted_" + label_column] = _round(float(pred)) if label_kind == "quantity" else _json_safe(pred)
            pending_predictions.append(record)

    return {
        "task_type": "supervised",
        "best_model": predictor.model_best,
        "eval_metric": str(predictor.eval_metric),
        "leaderboard": leaderboard_records,
        "why_model_won": _why_model_won(leaderboard_records, predictor.model_best),
        "feature_importance": [
            {"feature": feature, "importance": _round(row["importance"])}
            for feature, row in importance.iterrows()
        ],
        "pending_predictions": pending_predictions,
        "params": {
            "label_column": label_column,
            "label_kind": label_kind,
            "problem_type": str(predictor.problem_type),
            "time_limit_seconds": time_limit,
            "presets": "medium_quality",
            "training_rows": len(train_table),
            "pending_rows": len(pending_table),
        },
    }
