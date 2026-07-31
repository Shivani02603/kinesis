"""SQLite persistence: projects, the human review queue, and confirmed graph
versions. Plain stdlib sqlite3 — no ORM, this is a small, well-understood schema.

The review queue is what makes the system's questions durable and permanent:
once a human confirms or rejects an ambiguous merge, or acknowledges a
structural gap, that decision is stored here and fed back into the next
pipeline run (see backend/main.py) so the same question is never asked twice.
"""

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "app.db"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                industry TEXT,
                machine_capacity INTEGER
            );

            CREATE TABLE IF NOT EXISTS review_items (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                natural_key TEXT NOT NULL,
                payload TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                resolved_at TEXT
            );

            CREATE TABLE IF NOT EXISTS processed_files (
                project_id TEXT NOT NULL,
                filename TEXT NOT NULL,
                processed_at TEXT NOT NULL,
                PRIMARY KEY (project_id, filename)
            );

            CREATE TABLE IF NOT EXISTS graph_versions (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                snapshot TEXT NOT NULL,
                confirmed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS project_settings (
                project_id TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, key)
            );

            CREATE TABLE IF NOT EXISTS training_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                version_number INTEGER NOT NULL,
                objective TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'queued',
                task_type TEXT,
                decision_reasoning TEXT,
                result TEXT,
                error TEXT,
                model_path TEXT,
                created_at TEXT NOT NULL,
                finished_at TEXT
            );

            -- role is one of 'super_admin' (platform-wide, project_id NULL) |
            -- 'company_admin' | 'operational' (both tied to exactly one project_id —
            -- this is the multi-tenant boundary, same project_id every other table
            -- already scopes by).
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                project_id TEXT,
                name TEXT,
                job_title TEXT,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            );

            -- One row per notable thing that happened in a company's project —
            -- new data processed, a version confirmed, a live-sync pull. This is
            -- the Super Admin's read-only visibility into work a Company Admin
            -- now does entirely on their own; nothing here is ever approved or
            -- actioned, only recorded.
            CREATE TABLE IF NOT EXISTS activity_log (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            -- Production-mix planning: real, human-entered facts about what a company
            -- can produce and sell. Unlike scheduling's identify_inputs, nothing here
            -- is ever extracted from an upload — a Company Admin enters and edits these
            -- directly, and they persist across "generate plan" runs.
            CREATE TABLE IF NOT EXISTS plan_products (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                profit_per_unit REAL NOT NULL,
                demand_min REAL,
                demand_max REAL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS plan_resources (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                unit TEXT NOT NULL,
                available_capacity REAL NOT NULL,
                created_at TEXT NOT NULL
            );

            -- Sparse: a missing (product_id, resource_id) row means that product uses
            -- none of that resource.
            CREATE TABLE IF NOT EXISTS plan_consumption (
                project_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                resource_id TEXT NOT NULL,
                per_unit REAL NOT NULL,
                PRIMARY KEY (project_id, product_id, resource_id)
            );

            -- One row per "Generate plan" click. result is a fully self-contained
            -- snapshot of both the inputs used and the solved (or honestly-failed)
            -- outcome at that moment — never just ids referencing the live products/
            -- resources rows, since those are edited and deleted over time and would
            -- make old history unintelligible otherwise (same reasoning as
            -- graph_versions.snapshot storing a full copy rather than a reference).
            CREATE TABLE IF NOT EXISTS plan_runs (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                status TEXT NOT NULL,
                result TEXT,
                error TEXT,
                created_at TEXT NOT NULL,
                total_profit REAL
            );

            -- Machines are distinct from plan_resources: a machine has downtime
            -- (from the maintenance objective) and product-compatibility, neither
            -- of which mean anything for a pooled resource like material or budget.
            CREATE TABLE IF NOT EXISTS plan_machines (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                name TEXT NOT NULL,
                available_hours REAL NOT NULL,
                utilization_floor REAL,
                asset_name TEXT,
                created_at TEXT NOT NULL
            );

            -- Sparse: a missing (product_id, machine_id) row means that product
            -- cannot run on that machine at all. Doubles as the compatibility flag
            -- AND the processing rate — no separate boolean table needed.
            CREATE TABLE IF NOT EXISTS plan_machine_compatibility (
                project_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                machine_id TEXT NOT NULL,
                hours_per_unit REAL NOT NULL,
                PRIMARY KEY (project_id, product_id, machine_id)
            );
            """
        )
        # Migration for columns added after these tables already existed in
        # production DBs — CREATE TABLE IF NOT EXISTS above is a no-op once the
        # table exists, so new columns need an explicit ALTER.
        existing_project_cols = {r["name"] for r in conn.execute("PRAGMA table_info(projects)").fetchall()}
        if "industry" not in existing_project_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN industry TEXT")
        if "machine_capacity" not in existing_project_cols:
            conn.execute("ALTER TABLE projects ADD COLUMN machine_capacity INTEGER")
        existing_user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
        if "job_title" not in existing_user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN job_title TEXT")

        # price_per_unit/cost_per_unit replace profit_per_unit as the real inputs
        # (profit = price - cost, computed — never two numbers that could disagree).
        # profit_per_unit itself stays as a computed cache, never dropped, so rows
        # created before this migration keep working under the default objective.
        existing_product_cols = {r["name"] for r in conn.execute("PRAGMA table_info(plan_products)").fetchall()}
        for col, decl in (
            ("price_per_unit", "REAL"), ("cost_per_unit", "REAL"),
            ("batch_min", "REAL"), ("batch_max", "REAL"),
        ):
            if col not in existing_product_cols:
                conn.execute(f"ALTER TABLE plan_products ADD COLUMN {col} {decl}")

        existing_resource_cols = {r["name"] for r in conn.execute("PRAGMA table_info(plan_resources)").fetchall()}
        if "kind" not in existing_resource_cols:
            conn.execute("ALTER TABLE plan_resources ADD COLUMN kind TEXT")

        existing_run_cols = {r["name"] for r in conn.execute("PRAGMA table_info(plan_runs)").fetchall()}
        if "total_profit" not in existing_run_cols:
            conn.execute("ALTER TABLE plan_runs ADD COLUMN total_profit REAL")
        if "objective" not in existing_run_cols:
            conn.execute("ALTER TABLE plan_runs ADD COLUMN objective TEXT")
        if "objective_value" not in existing_run_cols:
            conn.execute("ALTER TABLE plan_runs ADD COLUMN objective_value REAL")

        # Constraints used to be permanently on (the old solver always enforced
        # demand/resources). Projects that already have products/resources today
        # must keep behaving that way after this migration — seed their toggles to
        # "on" once, idempotently. A brand-new project created after this ships
        # gets no seeded rows and sees the real default (off, user opts in).
        existing_plan_projects = {
            r["project_id"] for r in conn.execute("SELECT DISTINCT project_id FROM plan_products").fetchall()
        } | {
            r["project_id"] for r in conn.execute("SELECT DISTINCT project_id FROM plan_resources").fetchall()
        }
        for pid in existing_plan_projects:
            existing_keys = {
                r["key"] for r in conn.execute(
                    "SELECT key FROM project_settings WHERE project_id = ? AND key LIKE 'planning.constraint.%'",
                    (pid,),
                ).fetchall()
            }
            for key in (
                "planning.constraint.demand_ceiling", "planning.constraint.min_committed_order",
                "planning.constraint.pooled_resources", "planning.constraint.batch_size",
                "planning.constraint.utilization_floor",
            ):
                if key not in existing_keys:
                    conn.execute(
                        "INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, ?, 'true', ?)",
                        (pid, key, _now()),
                    )


@contextmanager
def _connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# ---- projects ----------------------------------------------------------

def create_project(name: str, industry: str | None = None, machine_capacity: int | None = None) -> dict:
    project_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO projects (id, name, created_at, industry, machine_capacity) VALUES (?, ?, ?, ?, ?)",
            (project_id, name, _now(), industry, machine_capacity),
        )
    return get_project(project_id)


def list_projects() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_project(project_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return dict(row) if row else None


# ---- users & sessions ------------------------------------------------------

def create_user(
    email: str,
    password_hash: str,
    role: str,
    project_id: str | None,
    name: str | None = None,
    job_title: str | None = None,
) -> dict:
    user_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO users (id, email, password_hash, role, project_id, name, job_title, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (user_id, email.strip().lower(), password_hash, role, project_id, name, job_title, _now()),
        )
    return get_user(user_id)


def get_user(user_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    return dict(row) if row else None


def get_user_by_email(email: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?", (email.strip().lower(),)).fetchone()
    return dict(row) if row else None


def list_users(project_id: str | None = None) -> list[dict]:
    with _connect() as conn:
        if project_id is not None:
            rows = conn.execute(
                "SELECT * FROM users WHERE project_id = ? ORDER BY created_at", (project_id,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT * FROM users ORDER BY created_at").fetchall()
    return [dict(r) for r in rows]


def last_active_map(project_id: str) -> dict[str, str]:
    """Most recent session created_at per user in this project — the real
    signal behind "active this week", not a fabricated status."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT s.user_id AS user_id, MAX(s.created_at) AS last_active "
            "FROM sessions s JOIN users u ON u.id = s.user_id "
            "WHERE u.project_id = ? GROUP BY s.user_id",
            (project_id,),
        ).fetchall()
    return {r["user_id"]: r["last_active"] for r in rows}


def any_user_exists() -> bool:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()
    return row["c"] > 0


def create_session(user_id: str, ttl_hours: int = 24 * 7) -> dict:
    token = uuid.uuid4().hex + uuid.uuid4().hex  # 64 hex chars, unguessable
    now = datetime.now(timezone.utc)
    expires_at = (now + timedelta(hours=ttl_hours)).isoformat()
    with _connect() as conn:
        conn.execute(
            "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
            (token, user_id, now.isoformat(), expires_at),
        )
    return {"token": token, "user_id": user_id, "expires_at": expires_at}


def get_session_user(token: str) -> dict | None:
    """Returns the user for a still-valid session token, or None if the token
    is unknown or has expired — expired sessions are deleted here too, so
    stale rows don't accumulate forever."""
    with _connect() as conn:
        row = conn.execute("SELECT * FROM sessions WHERE token = ?", (token,)).fetchone()
        if row is None:
            return None
        if row["expires_at"] < _now():
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            return None
        user_row = conn.execute("SELECT * FROM users WHERE id = ?", (row["user_id"],)).fetchone()
    return dict(user_row) if user_row else None


def delete_session(token: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))


# ---- review items --------------------------------------------------------

def _merge_natural_key(entity_a_id: str, entity_b_id: str) -> str:
    return "|".join(sorted((entity_a_id, entity_b_id)))


def get_decided_state(project_id: str) -> dict:
    """Everything already decided by a human, shaped for the pipeline to consume
    so it never re-asks a question it's already been answered."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM review_items WHERE project_id = ? AND status != 'pending'",
            (project_id,),
        ).fetchall()

    known_merge_pairs: set[tuple[str, str]] = set()
    known_distinct_pairs: set[tuple[str, str]] = set()
    acknowledged_gap_ids: set[str] = set()
    acknowledged_orphan_ids: set[str] = set()

    for row in rows:
        payload = json.loads(row["payload"])
        if row["kind"] == "ambiguous_merge":
            pair = tuple(sorted((payload["entity_a_id"], payload["entity_b_id"])))
            if row["status"] == "confirmed":
                known_merge_pairs.add(pair)
            elif row["status"] == "rejected":
                known_distinct_pairs.add(pair)
        elif row["kind"] == "stage_gap":
            acknowledged_gap_ids.add(payload["stage_id"])
        elif row["kind"] == "orphan":
            acknowledged_orphan_ids.add(payload["entity_id"])

    return {
        "known_merge_pairs": known_merge_pairs,
        "known_distinct_pairs": known_distinct_pairs,
        "acknowledged_gap_ids": acknowledged_gap_ids,
        "acknowledged_orphan_ids": acknowledged_orphan_ids,
    }


def sync_review_items(project_id: str, kind: str, items: list[dict]) -> None:
    """Insert freshly-found items as pending, skipping any whose natural key
    already exists (regardless of status) so a decided or already-queued
    question is never duplicated."""
    with _connect() as conn:
        existing_keys = {
            row["natural_key"]
            for row in conn.execute(
                "SELECT natural_key FROM review_items WHERE project_id = ? AND kind = ?",
                (project_id, kind),
            ).fetchall()
        }
        for item in items:
            if kind == "ambiguous_merge":
                key = _merge_natural_key(item["entity_a_id"], item["entity_b_id"])
            elif kind == "stage_gap":
                key = item["stage_id"]
            elif kind == "orphan":
                key = item["entity_id"]
            elif kind == "conflict":
                key = _merge_natural_key(item["entity_a_id"], item["entity_b_id"])
            else:
                raise ValueError(f"unknown review item kind: {kind}")

            if key in existing_keys:
                continue
            conn.execute(
                "INSERT INTO review_items (id, project_id, kind, natural_key, payload, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, 'pending', ?)",
                (str(uuid.uuid4()), project_id, kind, key, json.dumps(item), _now()),
            )


def list_review_items(project_id: str, status: str | None = None) -> list[dict]:
    with _connect() as conn:
        if status:
            rows = conn.execute(
                "SELECT * FROM review_items WHERE project_id = ? AND status = ? ORDER BY created_at",
                (project_id, status),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM review_items WHERE project_id = ? ORDER BY created_at",
                (project_id,),
            ).fetchall()
    out = []
    for row in rows:
        d = dict(row)
        d["payload"] = json.loads(d["payload"])
        out.append(d)
    return out


def resolve_review_item(item_id: str, status: str) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE review_items SET status = ?, resolved_at = ? WHERE id = ?",
            (status, _now(), item_id),
        )
        row = conn.execute("SELECT * FROM review_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["payload"] = json.loads(d["payload"])
    return d


def get_review_item(item_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM review_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["payload"] = json.loads(d["payload"])
    return d


def pending_count(project_id: str) -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM review_items WHERE project_id = ? AND status = 'pending'",
            (project_id,),
        ).fetchone()
    return row["c"]


# ---- processed files -------------------------------------------------------

def get_unprocessed_filenames(project_id: str, uploaded_filenames: list[str]) -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT filename FROM processed_files WHERE project_id = ?", (project_id,)
        ).fetchall()
    already = {r["filename"] for r in rows}
    return [f for f in uploaded_filenames if f not in already]


def mark_processed(project_id: str, filenames: list[str]) -> None:
    with _connect() as conn:
        for f in filenames:
            conn.execute(
                "INSERT OR IGNORE INTO processed_files (project_id, filename, processed_at) VALUES (?, ?, ?)",
                (project_id, f, _now()),
            )


# ---- graph versions -------------------------------------------------------

def confirm_version(project_id: str, snapshot: dict) -> dict:
    with _connect() as conn:
        row = conn.execute(
            "SELECT MAX(version_number) AS v FROM graph_versions WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        next_version = (row["v"] or 0) + 1
        version_id = str(uuid.uuid4())
        conn.execute(
            "INSERT INTO graph_versions (id, project_id, version_number, snapshot, confirmed_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (version_id, project_id, next_version, json.dumps(snapshot), _now()),
        )
    return {"id": version_id, "project_id": project_id, "version_number": next_version}


def list_versions(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, project_id, version_number, confirmed_at FROM graph_versions "
            "WHERE project_id = ? ORDER BY version_number DESC",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---- project settings -------------------------------------------------------
# Real business facts a human enters once (current stock on hand, a supplier's
# delivery lead time) — not something any graph or model can infer, and never
# invented by the system. Stored the same way review-queue answers are: a
# human-provided fact, fed into computation same as anything read from a file.

def set_setting(project_id: str, key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO project_settings (project_id, key, value, updated_at) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(project_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            (project_id, key, value, _now()),
        )


def get_settings(project_id: str) -> dict[str, str]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT key, value FROM project_settings WHERE project_id = ?", (project_id,)
        ).fetchall()
    return {r["key"]: r["value"] for r in rows}


# ---- training runs ---------------------------------------------------------

def create_training_run(
    project_id: str, version_number: int, objective: str, model_path: str, run_id: str | None = None
) -> dict:
    run_id = run_id or str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO training_runs (id, project_id, version_number, objective, status, model_path, created_at) "
            "VALUES (?, ?, ?, ?, 'queued', ?, ?)",
            (run_id, project_id, version_number, objective, model_path, _now()),
        )
    return get_training_run(run_id)


def update_training_run(
    run_id: str,
    status: str | None = None,
    task_type: str | None = None,
    decision_reasoning: str | None = None,
    result: dict | None = None,
    error: str | None = None,
    finished: bool = False,
) -> None:
    sets, params = [], []
    if status is not None:
        sets.append("status = ?")
        params.append(status)
    if task_type is not None:
        sets.append("task_type = ?")
        params.append(task_type)
    if decision_reasoning is not None:
        sets.append("decision_reasoning = ?")
        params.append(decision_reasoning)
    if result is not None:
        sets.append("result = ?")
        params.append(json.dumps(result))
    if error is not None:
        sets.append("error = ?")
        params.append(error)
    if finished:
        sets.append("finished_at = ?")
        params.append(_now())
    params.append(run_id)
    with _connect() as conn:
        conn.execute(f"UPDATE training_runs SET {', '.join(sets)} WHERE id = ?", params)


def _training_run_row_to_dict(row, include_result: bool) -> dict:
    d = dict(row)
    if include_result:
        d["result"] = json.loads(d["result"]) if d["result"] else None
    else:
        d.pop("result", None)
    return d


def list_training_runs(project_id: str, objective: str | None = None) -> list[dict]:
    with _connect() as conn:
        if objective:
            rows = conn.execute(
                "SELECT * FROM training_runs WHERE project_id = ? AND objective = ? ORDER BY created_at DESC",
                (project_id, objective),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM training_runs WHERE project_id = ? ORDER BY created_at DESC",
                (project_id,),
            ).fetchall()
    return [_training_run_row_to_dict(r, include_result=False) for r in rows]


# ---- activity log (Super Admin's read-only visibility) ---------------------

def log_activity(project_id: str, kind: str, message: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO activity_log (id, project_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)",
            (str(uuid.uuid4()), project_id, kind, message, _now()),
        )


def list_activity(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM activity_log WHERE project_id = ? ORDER BY created_at DESC", (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def get_training_run(run_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM training_runs WHERE id = ?", (run_id,)).fetchone()
    return _training_run_row_to_dict(row, include_result=True) if row else None


def has_active_training_run(project_id: str, objective: str | None = None) -> bool:
    """With an objective given, checks only that objective — different
    objectives may queue side by side; only the SAME objective twice at once
    is a duplicate."""
    query = "SELECT COUNT(*) AS c FROM training_runs WHERE project_id = ? AND status IN ('queued', 'running')"
    params: list = [project_id]
    if objective is not None:
        query += " AND objective = ?"
        params.append(objective)
    with _connect() as conn:
        row = conn.execute(query, params).fetchone()
    return row["c"] > 0


def get_version(version_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM graph_versions WHERE id = ?", (version_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["snapshot"] = json.loads(d["snapshot"])
    return d


# ---- production-mix planning (real, human-entered facts) -------------------

def create_plan_product(
    project_id: str, name: str, price_per_unit: float, cost_per_unit: float,
    demand_min: float | None = None, demand_max: float | None = None,
    batch_min: float | None = None, batch_max: float | None = None,
) -> dict:
    product_id = str(uuid.uuid4())
    profit_per_unit = price_per_unit - cost_per_unit
    with _connect() as conn:
        conn.execute(
            "INSERT INTO plan_products (id, project_id, name, profit_per_unit, price_per_unit, cost_per_unit, "
            "demand_min, demand_max, batch_min, batch_max, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (product_id, project_id, name, profit_per_unit, price_per_unit, cost_per_unit,
             demand_min, demand_max, batch_min, batch_max, _now()),
        )
        row = conn.execute("SELECT * FROM plan_products WHERE id = ?", (product_id,)).fetchone()
    return dict(row)


def get_plan_product(product_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM plan_products WHERE id = ?", (product_id,)).fetchone()
    return dict(row) if row else None


def list_plan_products(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM plan_products WHERE project_id = ? ORDER BY created_at", (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def update_plan_product(
    product_id: str, name: str, price_per_unit: float, cost_per_unit: float,
    demand_min: float | None, demand_max: float | None,
    batch_min: float | None = None, batch_max: float | None = None,
) -> dict | None:
    profit_per_unit = price_per_unit - cost_per_unit
    with _connect() as conn:
        conn.execute(
            "UPDATE plan_products SET name = ?, profit_per_unit = ?, price_per_unit = ?, cost_per_unit = ?, "
            "demand_min = ?, demand_max = ?, batch_min = ?, batch_max = ? WHERE id = ?",
            (name, profit_per_unit, price_per_unit, cost_per_unit, demand_min, demand_max,
             batch_min, batch_max, product_id),
        )
        row = conn.execute("SELECT * FROM plan_products WHERE id = ?", (product_id,)).fetchone()
    return dict(row) if row else None


def delete_plan_product(product_id: str) -> None:
    # No FK enforcement in this sqlite schema — the consumption matrix's and
    # the machine-compatibility matrix's references to this product must be
    # cleaned up explicitly here.
    with _connect() as conn:
        conn.execute("DELETE FROM plan_consumption WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM plan_machine_compatibility WHERE product_id = ?", (product_id,))
        conn.execute("DELETE FROM plan_products WHERE id = ?", (product_id,))


def create_plan_resource(
    project_id: str, name: str, unit: str, available_capacity: float, kind: str | None = None,
) -> dict:
    resource_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO plan_resources (id, project_id, name, unit, available_capacity, kind, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (resource_id, project_id, name, unit, available_capacity, kind, _now()),
        )
        row = conn.execute("SELECT * FROM plan_resources WHERE id = ?", (resource_id,)).fetchone()
    return dict(row)


def get_plan_resource(resource_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM plan_resources WHERE id = ?", (resource_id,)).fetchone()
    return dict(row) if row else None


def list_plan_resources(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM plan_resources WHERE project_id = ? ORDER BY created_at", (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def update_plan_resource(
    resource_id: str, name: str, unit: str, available_capacity: float, kind: str | None = None,
) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE plan_resources SET name = ?, unit = ?, available_capacity = ?, kind = ? WHERE id = ?",
            (name, unit, available_capacity, kind, resource_id),
        )
        row = conn.execute("SELECT * FROM plan_resources WHERE id = ?", (resource_id,)).fetchone()
    return dict(row) if row else None


def delete_plan_resource(resource_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM plan_consumption WHERE resource_id = ?", (resource_id,))
        conn.execute("DELETE FROM plan_resources WHERE id = ?", (resource_id,))


def create_plan_machine(
    project_id: str, name: str, available_hours: float,
    utilization_floor: float | None = None, asset_name: str | None = None,
) -> dict:
    machine_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO plan_machines (id, project_id, name, available_hours, utilization_floor, "
            "asset_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (machine_id, project_id, name, available_hours, utilization_floor, asset_name, _now()),
        )
        row = conn.execute("SELECT * FROM plan_machines WHERE id = ?", (machine_id,)).fetchone()
    return dict(row)


def get_plan_machine(machine_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM plan_machines WHERE id = ?", (machine_id,)).fetchone()
    return dict(row) if row else None


def list_plan_machines(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM plan_machines WHERE project_id = ? ORDER BY created_at", (project_id,)
        ).fetchall()
    return [dict(r) for r in rows]


def update_plan_machine(
    machine_id: str, name: str, available_hours: float,
    utilization_floor: float | None, asset_name: str | None,
) -> dict | None:
    with _connect() as conn:
        conn.execute(
            "UPDATE plan_machines SET name = ?, available_hours = ?, utilization_floor = ?, asset_name = ? "
            "WHERE id = ?",
            (name, available_hours, utilization_floor, asset_name, machine_id),
        )
        row = conn.execute("SELECT * FROM plan_machines WHERE id = ?", (machine_id,)).fetchone()
    return dict(row) if row else None


def delete_plan_machine(machine_id: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM plan_machine_compatibility WHERE machine_id = ?", (machine_id,))
        conn.execute("DELETE FROM plan_machines WHERE id = ?", (machine_id,))


def list_plan_machine_compatibility(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT product_id, machine_id, hours_per_unit FROM plan_machine_compatibility WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def set_plan_machine_compatibility(project_id: str, cells: list[dict]) -> None:
    """Atomic full replace — same delete-then-insert shape as set_plan_consumption."""
    with _connect() as conn:
        conn.execute("DELETE FROM plan_machine_compatibility WHERE project_id = ?", (project_id,))
        for cell in cells:
            conn.execute(
                "INSERT INTO plan_machine_compatibility (project_id, product_id, machine_id, hours_per_unit) "
                "VALUES (?, ?, ?, ?)",
                (project_id, cell["product_id"], cell["machine_id"], cell["hours_per_unit"]),
            )


def list_plan_consumption(project_id: str) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT product_id, resource_id, per_unit FROM plan_consumption WHERE project_id = ?",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def set_plan_consumption(project_id: str, cells: list[dict]) -> None:
    """Atomic full replace — one commit, same delete-then-insert shape as
    sync_review_items, so a partial write can never leave a stale mix of old
    and new cells."""
    with _connect() as conn:
        conn.execute("DELETE FROM plan_consumption WHERE project_id = ?", (project_id,))
        for cell in cells:
            conn.execute(
                "INSERT INTO plan_consumption (project_id, product_id, resource_id, per_unit) VALUES (?, ?, ?, ?)",
                (project_id, cell["product_id"], cell["resource_id"], cell["per_unit"]),
            )


def create_plan_run(
    project_id: str, status: str, result: dict | None = None, error: str | None = None,
    total_profit: float | None = None, objective: str | None = None, objective_value: float | None = None,
) -> dict:
    run_id = str(uuid.uuid4())
    with _connect() as conn:
        conn.execute(
            "INSERT INTO plan_runs (id, project_id, status, result, error, created_at, total_profit, "
            "objective, objective_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (run_id, project_id, status, json.dumps(result) if result is not None else None, error, _now(),
             total_profit, objective, objective_value),
        )
        row = conn.execute("SELECT * FROM plan_runs WHERE id = ?", (run_id,)).fetchone()
    d = dict(row)
    d["result"] = json.loads(d["result"]) if d["result"] else None
    return d


def get_plan_run(run_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM plan_runs WHERE id = ?", (run_id,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["result"] = json.loads(d["result"]) if d["result"] else None
    return d


def list_plan_runs(project_id: str) -> list[dict]:
    """Excludes the (potentially large) result payload, mirroring list_training_runs —
    the history list only needs status/timestamp; get_plan_run fetches one run in full."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, project_id, status, error, created_at, total_profit, objective, objective_value "
            "FROM plan_runs WHERE project_id = ? ORDER BY created_at DESC",
            (project_id,),
        ).fetchall()
    return [dict(r) for r in rows]
