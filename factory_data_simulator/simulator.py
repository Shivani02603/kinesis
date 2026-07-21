"""Factory data simulator — a standalone stand-in for a real plant's sensor
database / historian.

It seeds from the same tables Kinesis already understands (each table's first
column is its time key, the rest are signal columns), then generates NEW rows
forward in time on demand. Kinesis connects to this over HTTP and pulls only the
rows it hasn't seen yet (a real delta), so the two stay decoupled exactly like a
real ERP/historian integration.

Generation is grounded, not random: each signal continues from its own last value
with mean-reversion toward its historical baseline plus noise. A per-signal
"degrade" switch adds a genuine upward drift so a machine can be shown slowly
going out of its normal range — which is what makes a retrain visibly catch it.
Nothing here is a scripted "now it's broken" canned event.
"""

import csv
import json
import os
import random
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

SIM_DB = Path(__file__).parent / "sim.db"
SEED_DIR = Path(os.environ.get("SEED_DIR", Path(__file__).parent.parent / "data" / "steel_heat_treatment_small"))

# The two time-series tables that actually drive predictions. Both are seeded from
# the real fixtures; their signal columns are read from the file headers, never
# hardcoded here.
SEED_TABLES = ["sensor_readings.csv", "inspection_readings.csv"]


@contextmanager
def _conn():
    conn = sqlite3.connect(SIM_DB)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _parse_ts(value: str) -> datetime:
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            return datetime.strptime(value.strip(), fmt)
        except ValueError:
            continue
    return datetime.fromisoformat(value.strip())


def _fmt_ts(dt: datetime, daily: bool) -> str:
    return dt.strftime("%Y-%m-%d") if daily else dt.strftime("%Y-%m-%d %H:%M")


def init_db() -> None:
    with _conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                table_name TEXT NOT NULL,
                key_col TEXT NOT NULL,
                signal_cols TEXT NOT NULL,   -- json list
                daily INTEGER NOT NULL,      -- 1 = one row per day, 0 = per hour
                PRIMARY KEY (table_name)
            );
            CREATE TABLE IF NOT EXISTS rows (
                table_name TEXT NOT NULL,
                key_val TEXT NOT NULL,       -- the timestamp/date, the natural key
                payload TEXT NOT NULL,       -- json {col: value} for the whole row
                PRIMARY KEY (table_name, key_val)
            );
            CREATE TABLE IF NOT EXISTS baseline (
                table_name TEXT NOT NULL,
                signal_col TEXT NOT NULL,
                mean REAL NOT NULL,
                std REAL NOT NULL,
                last_value REAL NOT NULL,
                degrade INTEGER NOT NULL DEFAULT 0,
                drift_offset REAL NOT NULL DEFAULT 0,
                PRIMARY KEY (table_name, signal_col)
            );
            """
        )


def seeded() -> bool:
    with _conn() as conn:
        return conn.execute("SELECT COUNT(*) AS c FROM meta").fetchone()["c"] > 0


def seed_from_fixtures() -> None:
    """Load the real fixture rows as 'history so far' and compute each signal's
    baseline (mean/std) from that history — so generated data continues the real
    pattern rather than starting from nothing."""
    for table in SEED_TABLES:
        path = SEED_DIR / table
        if not path.exists():
            continue
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader)
            data_rows = [r for r in reader if any(c.strip() for c in r)]
        key_col = header[0]
        signal_cols = header[1:]
        daily = ":" not in (data_rows[0][0] if data_rows else "")

        with _conn() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO meta (table_name, key_col, signal_cols, daily) VALUES (?, ?, ?, ?)",
                (table, key_col, json.dumps(signal_cols), 1 if daily else 0),
            )
            values_by_col: dict[str, list[float]] = {c: [] for c in signal_cols}
            for r in data_rows:
                row_map = dict(zip(header, r))
                conn.execute(
                    "INSERT OR REPLACE INTO rows (table_name, key_val, payload) VALUES (?, ?, ?)",
                    (table, row_map[key_col], json.dumps(row_map)),
                )
                for c in signal_cols:
                    try:
                        values_by_col[c].append(float(row_map[c]))
                    except (ValueError, KeyError):
                        pass
            for c in signal_cols:
                vals = values_by_col[c] or [0.0]
                mean = sum(vals) / len(vals)
                var = sum((v - mean) ** 2 for v in vals) / len(vals)
                std = max(var ** 0.5, 1e-6)
                conn.execute(
                    "INSERT OR REPLACE INTO baseline (table_name, signal_col, mean, std, last_value, degrade) "
                    "VALUES (?, ?, ?, ?, ?, COALESCE((SELECT degrade FROM baseline WHERE table_name=? AND signal_col=?), 0))",
                    (table, c, mean, std, vals[-1], table, c),
                )


def _last_ts(conn, table: str) -> datetime | None:
    row = conn.execute("SELECT MAX(key_val) AS m FROM rows WHERE table_name = ?", (table,)).fetchone()
    return _parse_ts(row["m"]) if row and row["m"] else None


def advance(hours: int) -> dict:
    """Generate `hours` more hours of data on every table. Hourly tables get one
    row per hour; daily tables get one row per day boundary crossed."""
    generated: dict[str, int] = {}
    with _conn() as conn:
        metas = conn.execute("SELECT * FROM meta").fetchall()
        for meta in metas:
            table = meta["table_name"]
            signal_cols = json.loads(meta["signal_cols"])
            daily = bool(meta["daily"])
            step = timedelta(days=1) if daily else timedelta(hours=1)
            n_steps = hours // 24 if daily else hours
            last = _last_ts(conn, table)
            if last is None:
                continue

            baselines = {
                b["signal_col"]: dict(
                    mean=b["mean"], std=b["std"], last=b["last_value"],
                    degrade=bool(b["degrade"]), offset=b["drift_offset"],
                )
                for b in conn.execute("SELECT * FROM baseline WHERE table_name = ?", (table,)).fetchall()
            }
            # Per-step drift: while a signal is degrading, its target climbs by this
            # much each step, so it steadily leaves its normal band instead of being
            # pulled back by mean-reversion. Sized so a normal demo advance (a couple
            # of days) clears the band comfortably.
            drift_step = (0.06 if not daily else 0.5)
            count = 0
            ts = last
            for _ in range(n_steps):
                ts = ts + step
                row_map = {meta["key_col"]: _fmt_ts(ts, daily)}
                for c in signal_cols:
                    b = baselines.get(c)
                    if b is None:
                        continue
                    if b["degrade"]:
                        b["offset"] += drift_step * b["std"]
                    # Revert toward the CURRENT target (baseline + accumulated drift),
                    # so a degrading signal genuinely rises and stays high (like a
                    # bearing going bad) rather than a tiny bump that reversion erases.
                    target = b["mean"] + b["offset"]
                    reversion = 0.3 * (target - b["last"])
                    noise = random.gauss(0, b["std"] * 0.5)
                    new_val = max(0.0, b["last"] + reversion + noise)
                    b["last"] = new_val
                    row_map[c] = round(new_val, 3)
                conn.execute(
                    "INSERT OR REPLACE INTO rows (table_name, key_val, payload) VALUES (?, ?, ?)",
                    (table, row_map[meta["key_col"]], json.dumps(row_map)),
                )
                count += 1
            for c, b in baselines.items():
                conn.execute(
                    "UPDATE baseline SET last_value = ?, drift_offset = ? WHERE table_name = ? AND signal_col = ?",
                    (b["last"], b["offset"], table, c),
                )
            generated[table] = count
    return generated


def set_degrade(signal_col: str, on: bool) -> bool:
    with _conn() as conn:
        if on:
            cur = conn.execute("UPDATE baseline SET degrade = 1 WHERE signal_col = ?", (signal_col,))
        else:
            # Turning degrade off = the machine was serviced: stop climbing AND let the
            # accumulated drift fall away so it returns to normal on the next advances.
            cur = conn.execute(
                "UPDATE baseline SET degrade = 0, drift_offset = 0 WHERE signal_col = ?", (signal_col,)
            )
        return cur.rowcount > 0


def list_tables() -> list[dict]:
    with _conn() as conn:
        out = []
        for m in conn.execute("SELECT * FROM meta").fetchall():
            n = conn.execute("SELECT COUNT(*) AS c FROM rows WHERE table_name = ?", (m["table_name"],)).fetchone()["c"]
            out.append(
                {
                    "table": m["table_name"],
                    "key_col": m["key_col"],
                    "signal_cols": json.loads(m["signal_cols"]),
                    "row_count": n,
                }
            )
        return out


def get_rows(table: str, since: str | None) -> list[dict]:
    """Rows whose key (timestamp/date) is strictly after `since` — the delta.
    String comparison is correct here because the key format is ISO-ordered."""
    with _conn() as conn:
        if since:
            rows = conn.execute(
                "SELECT payload FROM rows WHERE table_name = ? AND key_val > ? ORDER BY key_val",
                (table, since),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT payload FROM rows WHERE table_name = ? ORDER BY key_val", (table,)
            ).fetchall()
    return [json.loads(r["payload"]) for r in rows]


def status() -> dict:
    with _conn() as conn:
        tables = []
        for m in conn.execute("SELECT * FROM meta").fetchall():
            last = _last_ts(conn, m["table_name"])
            tables.append({"table": m["table_name"], "latest": _fmt_ts(last, bool(m["daily"])) if last else None})
        degraded = [
            b["signal_col"] for b in conn.execute("SELECT * FROM baseline WHERE degrade = 1").fetchall()
        ]
        signals = [
            {"signal": b["signal_col"], "table": b["table_name"], "degrade": bool(b["degrade"])}
            for b in conn.execute("SELECT * FROM baseline ORDER BY table_name, signal_col").fetchall()
        ]
    return {"tables": tables, "degraded": degraded, "signals": signals}
