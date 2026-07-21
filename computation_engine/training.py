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
    # AutoGluon doesn't always hand back the leaderboard best-first (observed: the
    # worst model sitting at row 1), which made the numbered "#" column meaningless
    # and the winner appear near the bottom. Sort best-first ourselves — higher
    # score_val is always better in AutoGluon — so rank 1 really is the best, and a
    # "runner-up" is genuinely the second-best. Unscored models (None) go last.
    records.sort(key=lambda r: (r["score_val"] is None, -(r["score_val"] or 0)))
    return records


def _why_model_won(leaderboard_records: list[dict], best_model: str) -> str | None:
    """A sentence built only from the real leaderboard numbers — never an invented
    explanation. AutoGluon orients score_val so HIGHER is always better (it negates
    error metrics), so we can say that plainly without knowing the metric. Fit time
    is deliberately left out of the reason: a model doesn't win for being fast or
    slow, only for being more accurate — mentioning speed here (the old "X% longer
    to fit") read as if it mattered to the choice, which it doesn't."""
    scored = [r for r in leaderboard_records if r["score_val"] is not None]
    winner = next((r for r in scored if r["model"] == best_model), None)
    if winner is None:
        return None
    others = [r for r in scored if r["model"] != best_model]
    if not others:
        return f"{winner['model']} was the only model that could be scored, so it was kept."

    # The runner-up is the best-scoring OTHER model — computed directly, never
    # assumed from list order (AutoGluon's row order can't be trusted, which is
    # exactly what made an earlier version compare against the worst model).
    runner_up = max(others, key=lambda r: r["score_val"])
    w, r = winner["score_val"], runner_up["score_val"]
    if round(w, 4) == round(r, 4):
        # A genuine tie at the shown precision — never phrase it as "X vs X", which
        # reads broken; say they matched and this one was ranked on top.
        return (
            f"{winner['model']} was ranked top, matching {runner_up['model']} on accuracy "
            f"(both about {w} on unseen validation data — higher is better)."
        )
    return (
        f"{winner['model']} was the most accurate on unseen validation data "
        f"({w} vs {runner_up['model']}'s {r} — higher is better)."
    )


def _ensemble_composition_ts(predictor, best_model: str) -> list[dict] | None:
    """The real component weights of a winning time-series WeightedEnsemble, read
    from AutoGluon's own fitted ensemble object. Best-effort by design: if the
    winner isn't an ensemble, or this AutoGluon version stores the weights
    differently, it returns None and the UI shows nothing — it never guesses a
    breakdown. Every number here is AutoGluon's, not ours."""
    if "Ensemble" not in best_model:
        return None
    try:
        model = predictor._learner.load_trainer().load_model(best_model)  # noqa: SLF001
        weights = getattr(model, "model_to_weight", None)
        if isinstance(weights, dict) and weights:
            pairs = [
                {"model": name, "weight": round(float(w), 4)}
                for name, w in weights.items()
                if w and float(w) > 0
            ]
            return sorted(pairs, key=lambda p: -p["weight"]) or None
    except Exception:  # noqa: BLE001 — an internal-API mismatch must degrade to "no breakdown"
        return None
    return None


def _ensemble_composition_tabular(predictor, best_model: str) -> list[dict] | None:
    """Same best-effort extraction for a tabular WeightedEnsemble."""
    if "Ensemble" not in best_model:
        return None
    try:
        model = predictor._trainer.load_model(best_model)  # noqa: SLF001
        inner = getattr(model, "model", model)
        weights = getattr(inner, "weights_", None)
        base = getattr(model, "base_model_names", None) or getattr(inner, "base_model_names", None)
        if weights is not None and base is not None and len(weights) == len(base):
            pairs = [
                {"model": b, "weight": round(float(w), 4)}
                for b, w in zip(base, weights)
                if w and float(w) > 0
            ]
            return sorted(pairs, key=lambda p: -p["weight"]) or None
    except Exception:  # noqa: BLE001
        return None
    return None


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
    time_limit: int | None = 600,
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
        "ensemble_composition": _ensemble_composition_ts(predictor, predictor.model_best),
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
    time_limit: int | None = 600,
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
        "ensemble_composition": _ensemble_composition_tabular(predictor, predictor.model_best),
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
