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

Multi-tenant: one running process serves every industry under DATA_ROOT. The
industry is not fixed at startup — every function takes it as a parameter, and
each industry gets its own SQLite file (`sim_<industry>.db`) so their generated
data never mixes. This is what lets one deployed instance stand in for every
company's factory instead of one process per industry.
"""

import csv
import json
import os
import random
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path

BASE_DIR = Path(__file__).parent
# Point this at the folder that holds one subfolder per industry
# (data/simulator_data/<industry>/*.csv). Nothing here is steel-specific — the
# tables and their signal columns are all discovered from the files, so any
# industry subfolder works the same way.
DATA_ROOT = Path(os.environ.get("SIMULATOR_DATA_ROOT", BASE_DIR.parent / "data" / "simulator_data"))


class UnknownIndustry(ValueError):
    pass


def list_industries() -> list[str]:
    """Every subfolder of DATA_ROOT that actually has CSVs in it — this is the
    live list of factories this instance can stand in for."""
    if not DATA_ROOT.is_dir():
        return []
    return sorted(p.name for p in DATA_ROOT.iterdir() if p.is_dir() and any(p.glob("*.csv")))


def _seed_dir(industry: str) -> Path:
    return DATA_ROOT / industry


def _require_industry(industry: str) -> Path:
    d = _seed_dir(industry)
    if not d.is_dir():
        raise UnknownIndustry(f"no such industry: {industry!r} (known: {list_industries()})")
    return d


def _db_path(industry: str) -> Path:
    return BASE_DIR / f"sim_{industry}.db"


@contextmanager
def _conn(industry: str):
    conn = sqlite3.connect(_db_path(industry))
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


def init_db(industry: str) -> None:
    with _conn(industry) as conn:
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


def seeded(industry: str) -> bool:
    with _conn(industry) as conn:
        return conn.execute("SELECT COUNT(*) AS c FROM meta").fetchone()["c"] > 0


def ensure_seeded(industry: str) -> None:
    """Validate the industry exists, then init + seed its own db on first use.
    Called at the top of every endpoint so a brand-new industry works with zero
    setup beyond dropping its folder under DATA_ROOT."""
    _require_industry(industry)
    init_db(industry)
    if not seeded(industry):
        seed_from_fixtures(industry)


def _is_time_series_csv(header: list[str], rows: list[list[str]]) -> bool:
    """A table this simulator can continue = a date/time first column, and EVERY
    other column numeric (a genuine sensor/metric-over-time table). This is what
    lets the simulator work for any industry from its files alone: it skips
    machine lists, routings, orders (non-date key or non-numeric columns) and
    keeps only real time-series, without any hardcoded filename list."""
    if not header or len(header) < 2 or not rows:
        return False
    try:
        for r in rows:
            _parse_ts(r[0])
    except (ValueError, IndexError):
        return False
    for r in rows:
        for cell in r[1:]:
            cell = cell.strip()
            if cell == "":
                continue
            try:
                float(cell)
            except ValueError:
                return False
    return True


def seed_from_fixtures(industry: str) -> None:
    """Auto-discover every time-series table in this industry's folder and load
    its rows as 'history so far', computing each signal's baseline (mean/std) so
    generated data continues the real pattern. No hardcoded table names — any
    industry folder seeds whatever real time-series files are there."""
    seed_dir = _require_industry(industry)
    for path in sorted(seed_dir.glob("*.csv")):
        with open(path, newline="", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
            if header is None:
                continue
            data_rows = [r for r in reader if any(c.strip() for c in r)]
        if not _is_time_series_csv(header, data_rows[:20]):
            continue
        table = path.name
        key_col = header[0]
        signal_cols = header[1:]
        daily = ":" not in (data_rows[0][0] if data_rows else "")

        with _conn(industry) as conn:
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


def advance(industry: str, hours: int) -> dict:
    """Generate `hours` more hours of data on every table. Hourly tables get one
    row per hour; daily tables get one row per day boundary crossed."""
    generated: dict[str, int] = {}
    with _conn(industry) as conn:
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


def set_degrade(industry: str, signal_col: str, on: bool) -> bool:
    with _conn(industry) as conn:
        if on:
            cur = conn.execute("UPDATE baseline SET degrade = 1 WHERE signal_col = ?", (signal_col,))
        else:
            # Turning degrade off = the machine was serviced: stop climbing AND let the
            # accumulated drift fall away so it returns to normal on the next advances.
            cur = conn.execute(
                "UPDATE baseline SET degrade = 0, drift_offset = 0 WHERE signal_col = ?", (signal_col,)
            )
        return cur.rowcount > 0


def list_tables(industry: str) -> list[dict]:
    with _conn(industry) as conn:
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


def get_rows(industry: str, table: str, since: str | None) -> list[dict]:
    """Rows whose key (timestamp/date) is strictly after `since` — the delta.
    String comparison is correct here because the key format is ISO-ordered."""
    with _conn(industry) as conn:
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


def reseed(industry: str) -> None:
    """Wipe this industry's db and re-seed from its real fixtures."""
    db = _db_path(industry)
    if db.exists():
        os.remove(db)
    init_db(industry)
    seed_from_fixtures(industry)


def status(industry: str) -> dict:
    with _conn(industry) as conn:
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
