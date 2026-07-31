"""FastAPI surface over the Understanding Engine.

Every route is a thin wrapper: parse request -> call understanding_engine
(pure logic) or db (persistence) -> return JSON. No business logic lives here
beyond wiring the two together and translating human review actions (confirm/
reject/needs_fix) into the actual Neo4j merge that a "confirm" implies.
"""

import re
import sys
import threading
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

load_dotenv(override=True)

sys.path.insert(0, str(Path(__file__).parent.parent))

from understanding_engine.feasibility import check_feasibility  # noqa: E402
from understanding_engine.graph_store import GraphStore  # noqa: E402
from understanding_engine.pipeline import run_pipeline  # noqa: E402
from decision_layer.narration import SUMMARIZERS, Card, summarize_deviation, summarize_maintenance  # noqa: E402
from planning_engine.solver import solve_production_mix  # noqa: E402

from . import auth, data_connector, db  # noqa: E402

# Settings key holding the external data source's base URL (the factory_data_simulator,
# or a real ERP/historian with the same delta API) for a project.
_DATA_SOURCE_URL_KEY = "data_source.url"

UPLOAD_ROOT = Path(__file__).parent / "uploads"

store: GraphStore | None = None

# Live discovery progress, keyed by project_id — one in-flight run at a time per
# project (mirrors the app's single-process dev deployment; not meant to survive
# a server restart, same tradeoff as everything else kept in-process here). The
# frontend polls this to render a live "discovery running" view instead of
# blocking on the whole pipeline before showing anything.
_discovery_progress: dict[str, dict] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    global store
    db.init_db()
    store = GraphStore()
    yield
    store.close()


app = FastAPI(title="Understanding Engine API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)

_PROJECT_ID_IN_PATH = re.compile(r"^/api/projects/([^/]+)")


@app.middleware("http")
async def auth_gate(request: Request, call_next):
    """Every /api/* route (except /api/auth/* itself) requires a valid
    session; a company_admin/operational user is further confined to their
    own project_id. super_admin passes both checks unconditionally. This is
    the one place enforcing the tier model — new routes are covered for free,
    nobody has to remember to add a dependency to each handler."""
    path = request.url.path
    if request.method == "OPTIONS" or not path.startswith("/api/") or path.startswith("/api/auth/"):
        return await call_next(request)

    authorization = request.headers.get("authorization")
    token = authorization.split(" ", 1)[1].strip() if authorization and authorization.lower().startswith("bearer ") else None
    user = db.get_session_user(token) if token else None
    if user is None:
        return JSONResponse(status_code=401, content={"detail": "Not authenticated — please log in"})

    if path == "/api/projects":
        if user["role"] != "super_admin":
            return JSONResponse(status_code=403, content={"detail": "Only a Super Admin can do this"})
    else:
        match = _PROJECT_ID_IN_PATH.match(path)
        if match and user["role"] != "super_admin" and user.get("project_id") != match.group(1):
            return JSONResponse(status_code=403, content={"detail": "You don't have access to this company's data"})

    return await call_next(request)


class LoginRequest(BaseModel):
    email: str
    password: str


def _user_public(user: dict, last_active: str | None = None) -> dict:
    return {
        "id": user["id"],
        "email": user["email"],
        "role": user["role"],
        "project_id": user["project_id"],
        "name": user["name"],
        "job_title": user.get("job_title"),
        "last_active_at": last_active,
    }


@app.post("/api/auth/login")
def login(body: LoginRequest):
    user = db.get_user_by_email(body.email)
    if user is None or not auth.verify_password(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Incorrect email or password")
    session = db.create_session(user["id"])
    return {"token": session["token"], "user": _user_public(user)}


@app.post("/api/auth/logout")
def logout(current: dict = Depends(auth.current_user), authorization: str = Header(...)):
    db.delete_session(authorization.split(" ", 1)[1].strip())
    return {"ok": True}


@app.get("/api/auth/me")
def me(current: dict = Depends(auth.current_user)):
    return _user_public(current)


class CreateProjectRequest(BaseModel):
    name: str
    industry: str | None = None
    machine_capacity: int | None = None


class ResolveReviewItemRequest(BaseModel):
    resolution: str  # "confirmed" | "rejected" | "needs_fix"


def _project_or_404(project_id: str) -> dict:
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _enrich_project(project: dict) -> dict:
    """Adds fields no table stores directly but that are real, derivable facts:
    how many Asset nodes the confirmed graph has, and the latest confirmed
    version number — both computed from Neo4j / graph_versions, never invented."""
    project["pending_review_count"] = db.pending_count(project["id"])
    project["asset_count"] = store.count_nodes(project["id"], "Asset")
    versions = db.list_versions(project["id"])
    project["latest_version"] = versions[0]["version_number"] if versions else None
    return project


@app.post("/api/projects")
def create_project(body: CreateProjectRequest):
    project = db.create_project(body.name, body.industry, body.machine_capacity)
    (UPLOAD_ROOT / project["id"]).mkdir(parents=True, exist_ok=True)
    return _enrich_project(project)


@app.get("/api/projects")
def list_projects():
    return [_enrich_project(p) for p in db.list_projects()]


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    project = _project_or_404(project_id)
    return _enrich_project(project)


# ---- people & roles (Tier 2: Company Admin manages its own project's users) ----

class CreateUserRequest(BaseModel):
    email: str
    password: str
    role: str  # "company_admin" | "operational" — never "super_admin" via this route
    name: str | None = None
    job_title: str | None = None


@app.get("/api/projects/{project_id}/users")
def list_project_users(project_id: str):
    _project_or_404(project_id)
    active = db.last_active_map(project_id)
    return [_user_public(u, active.get(u["id"])) for u in db.list_users(project_id)]


@app.post("/api/projects/{project_id}/users")
def create_project_user(project_id: str, body: CreateUserRequest):
    _project_or_404(project_id)
    if body.role not in ("company_admin", "operational"):
        raise HTTPException(status_code=400, detail="role must be company_admin or operational")
    if db.get_user_by_email(body.email) is not None:
        raise HTTPException(status_code=409, detail="a user with this email already exists")
    user = db.create_user(body.email, auth.hash_password(body.password), body.role, project_id, body.name, body.job_title)
    return _user_public(user)


# Streamed to disk in bounded chunks below rather than read into memory in one
# shot — a multi-gigabyte source file must not require a multi-gigabyte spike
# in server RAM just to save it. 1 MiB keeps memory flat regardless of how
# large the uploaded file actually is.
_UPLOAD_CHUNK_SIZE = 1024 * 1024


@app.post("/api/projects/{project_id}/upload")
async def upload_files(project_id: str, files: list[UploadFile]):
    _project_or_404(project_id)
    project_dir = UPLOAD_ROOT / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        dest = project_dir / f.filename
        with open(dest, "wb") as out:
            while chunk := await f.read(_UPLOAD_CHUNK_SIZE):
                out.write(chunk)
        saved.append(f.filename)
    return {"saved": saved}


@app.get("/api/projects/{project_id}/files")
def list_files(project_id: str):
    _project_or_404(project_id)
    project_dir = UPLOAD_ROOT / project_id
    if not project_dir.exists():
        return []
    filenames = [p.name for p in project_dir.iterdir() if p.is_file()]
    unprocessed = set(db.get_unprocessed_filenames(project_id, filenames))
    return [{"filename": f, "processed": f not in unprocessed} for f in filenames]


_DISCOVERY_LOCK = threading.Lock()

# (phase, sub-phase) shown while a given step is the furthest one reached —
# matches the 5 real phases run_pipeline actually goes through, nothing invented.
_DISCOVERY_PHASES = {
    0: ("Parsing sources", "Reading the uploaded files"),
    1: ("Extracting entities", "Asking the model what each thing is"),
    2: ("Resolving duplicates", "Same thing, different names?"),
    3: ("Building graph", "Wiring relationships in Neo4j"),
    4: ("Validating", "Checking for gaps & orphans"),
}


def _fresh_progress() -> dict:
    return {
        "status": "queued", "step": 0, "phase": "Starting…",
        "phase_sub": "Reading the uploaded sources", "log": [],
        "entities": 0, "merges": 0, "gaps": 0, "error": None,
    }


def _execute_discovery_run(project_id: str, new_filenames: list[str]):
    # Runs in Starlette's background threadpool after the response is sent, same
    # pattern as _execute_training_run. Every log line pushed into
    # _discovery_progress is a real message run_pipeline emitted about this
    # specific run's own data — never a scripted placeholder.
    project_dir = UPLOAD_ROOT / project_id
    progress = _discovery_progress[project_id]

    def on_event(step: int, tag: str, text: str):
        with _DISCOVERY_LOCK:
            progress["step"] = max(progress["step"], step)
            phase, sub = _DISCOVERY_PHASES[step]
            progress["phase"] = phase
            progress["phase_sub"] = sub
            progress["log"].append({"tag": tag, "text": text})
            progress["log"] = progress["log"][-200:]
            if tag == "extract":
                progress["entities"] += 1
            elif tag == "resolve" and (text.startswith("RESOLVED") or text.startswith("EXACT-NAME-MATCH") or text.startswith("CONFIRMED-MERGE")):
                progress["merges"] += 1
            elif tag == "resolve" and text.startswith("AMBIGUOUS"):
                progress["gaps"] += 1
            elif tag == "validate":
                progress["gaps"] += 1

    with _DISCOVERY_LOCK:
        progress["status"] = "running"

    try:
        decided = db.get_decided_state(project_id)
        result = run_pipeline(
            project_id=project_id,
            source_paths=[project_dir / f for f in new_filenames],
            store=store,
            known_merge_pairs=decided["known_merge_pairs"],
            known_distinct_pairs=decided["known_distinct_pairs"],
            acknowledged_gap_ids=decided["acknowledged_gap_ids"],
            acknowledged_orphan_ids=decided["acknowledged_orphan_ids"],
            on_event=on_event,
        )
        db.mark_processed(project_id, new_filenames)
        db.sync_review_items(project_id, "ambiguous_merge", [asdict(m) for m in result.ambiguous_merge_queue])
        db.sync_review_items(project_id, "stage_gap", [asdict(g) for g in result.stage_gaps])
        db.sync_review_items(project_id, "orphan", [asdict(o) for o in result.orphans])
        db.sync_review_items(project_id, "conflict", [asdict(c) for c in result.conflicts])

        with _DISCOVERY_LOCK:
            progress["status"] = "succeeded"
            progress["step"] = 5
            progress["phase"] = "Discovery complete"
            progress["phase_sub"] = "Ready for human review"
            progress["entities"] = len(result.resolved_entities)
            progress["merges"] = sum(1 for r in result.resolved_entities if len(r.merged_from) > 1)
            progress["gaps"] = db.pending_count(project_id)
            progress["log"].append(
                {
                    "tag": "ok",
                    "text": f"Done — {progress['entities']} entities, {progress['merges']} auto-merged, "
                    f"{progress['gaps']} questions",
                }
            )
        db.log_activity(
            project_id, "data_processed",
            f"New data processed from {len(new_filenames)} file(s) — {progress['entities']} entities, "
            f"{progress['merges']} auto-merged"
            + (f", {progress['gaps']} question(s) need review." if progress["gaps"] else ", no open questions."),
        )
    except Exception as exc:  # noqa: BLE001 — the progress record is the error channel
        with _DISCOVERY_LOCK:
            progress["status"] = "failed"
            progress["error"] = str(exc)


@app.post("/api/projects/{project_id}/run")
def run(project_id: str, background_tasks: BackgroundTasks):
    _project_or_404(project_id)
    project_dir = UPLOAD_ROOT / project_id
    all_filenames = [p.name for p in project_dir.iterdir() if p.is_file()] if project_dir.exists() else []
    new_filenames = db.get_unprocessed_filenames(project_id, all_filenames)
    if not new_filenames:
        return {"message": "no new files to process", "processed": []}

    existing = _discovery_progress.get(project_id)
    if existing and existing["status"] == "running":
        raise HTTPException(status_code=409, detail="A discovery run is already in progress for this project")

    _discovery_progress[project_id] = _fresh_progress()
    background_tasks.add_task(_execute_discovery_run, project_id, new_filenames)
    return {"processed": new_filenames}


@app.get("/api/projects/{project_id}/run/progress")
def get_discovery_progress(project_id: str):
    _project_or_404(project_id)
    return _discovery_progress.get(
        project_id,
        {"status": "idle", "step": 0, "phase": "", "phase_sub": "", "log": [], "entities": 0, "merges": 0, "gaps": 0, "error": None},
    )


@app.get("/api/projects/{project_id}/graph")
def get_graph(project_id: str):
    _project_or_404(project_id)
    return store.fetch_graph(project_id)


@app.get("/api/projects/{project_id}/review")
def get_review_items(project_id: str, status: str | None = None):
    _project_or_404(project_id)
    return db.list_review_items(project_id, status=status)


@app.post("/api/projects/{project_id}/review/{item_id}/resolve")
def resolve_review_item(project_id: str, item_id: str, body: ResolveReviewItemRequest):
    _project_or_404(project_id)
    item = db.get_review_item(item_id)
    if not item or item["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="review item not found")
    if body.resolution not in ("confirmed", "rejected", "needs_fix"):
        raise HTTPException(status_code=400, detail="resolution must be confirmed, rejected, or needs_fix")

    if item["kind"] == "ambiguous_merge" and body.resolution == "confirmed":
        payload = item["payload"]
        store.merge_node_into(
            project_id,
            absorbed_id=payload["entity_b_id"],
            canonical_id=payload["entity_a_id"],
        )

    return db.resolve_review_item(item_id, body.resolution)


@app.post("/api/projects/{project_id}/confirm-version")
def confirm_version(project_id: str):
    _project_or_404(project_id)
    pending = db.pending_count(project_id)
    if pending > 0:
        raise HTTPException(
            status_code=409,
            detail=f"{pending} review item(s) still pending — resolve them before confirming a version",
        )
    snapshot = store.fetch_graph(project_id)
    version = db.confirm_version(project_id, snapshot)
    db.log_activity(project_id, "version_confirmed", f"Version {version['version_number']} confirmed.")
    return version


@app.get("/api/projects/{project_id}/versions")
def list_versions(project_id: str):
    _project_or_404(project_id)
    return db.list_versions(project_id)


@app.get("/api/projects/{project_id}/activity")
def get_activity(project_id: str):
    """Read-only feed for the Super Admin: what a Company Admin has done on their
    own — new data processed, versions confirmed, live-sync pulls. Nothing here is
    ever approved or actioned, only recorded, per the platform's tier model where
    Company Admin owns their own project end-to-end."""
    _project_or_404(project_id)
    return db.list_activity(project_id)


# ---- project settings (real human-entered facts, e.g. supplier lead time) --

class SetSettingRequest(BaseModel):
    key: str
    value: str


@app.get("/api/projects/{project_id}/settings")
def get_settings(project_id: str):
    _project_or_404(project_id)
    return db.get_settings(project_id)


@app.put("/api/projects/{project_id}/settings")
def put_setting(project_id: str, body: SetSettingRequest):
    _project_or_404(project_id)
    db.set_setting(project_id, body.key, body.value)
    return db.get_settings(project_id)


# ---- data connections (Point 3: external source → append → retrain) ---------

class SetDataSourceBody(BaseModel):
    url: str


@app.get("/api/projects/{project_id}/data-source")
def get_data_source(project_id: str):
    _project_or_404(project_id)
    url = db.get_settings(project_id).get(_DATA_SOURCE_URL_KEY)
    if not url:
        return {"configured": False, "url": None, "files": [], "source_signals": []}
    try:
        status = data_connector.source_status(project_id, UPLOAD_ROOT / project_id, url)
        return {"configured": True, "url": url, "reachable": True, **status}
    except Exception as exc:  # noqa: BLE001 — an unreachable source is a normal state to report
        return {"configured": True, "url": url, "reachable": False, "error": str(exc), "files": [], "source_signals": []}


@app.put("/api/projects/{project_id}/data-source")
def set_data_source(project_id: str, body: SetDataSourceBody):
    _project_or_404(project_id)
    db.set_setting(project_id, _DATA_SOURCE_URL_KEY, body.url.strip())
    return {"configured": True, "url": body.url.strip()}


@app.post("/api/projects/{project_id}/data-source/refresh")
def refresh_data_source(project_id: str, background_tasks: BackgroundTasks):
    _project_or_404(project_id)
    if not db.list_versions(project_id):
        raise HTTPException(status_code=409, detail="Confirm a graph version before pulling live data into it")
    url = db.get_settings(project_id).get(_DATA_SOURCE_URL_KEY)
    if not url:
        raise HTTPException(status_code=409, detail="No data source configured — set the source URL first")
    try:
        summary = data_connector.refresh_from_source(project_id, UPLOAD_ROOT / project_id, url)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Could not reach the data source: {exc}")

    # Retrain only if new data actually arrived — otherwise a refresh is a no-op and
    # there's nothing to relearn. Runs in the background so the pull returns instantly.
    if summary["total_rows_added"] > 0:
        background_tasks.add_task(_train_all_objectives, project_id)
        summary["retraining"] = True
        synced_files = ", ".join(f["file"] for f in summary["files"] if f["rows_added"] > 0)
        db.log_activity(
            project_id, "live_sync",
            f"Pulled {summary['total_rows_added']} new reading(s) via live sync ({synced_files}); retraining.",
        )
    else:
        summary["retraining"] = False
    return summary


@app.get("/api/projects/{project_id}/feasibility")
def get_feasibility(project_id: str, objective: str = "maintenance"):
    _project_or_404(project_id)
    # Feasibility only ever runs against a confirmed graph — checking an
    # in-progress one (open review questions, possibly-wrong merges) would
    # give a verdict that a later confirmation could immediately invalidate.
    if not db.list_versions(project_id):
        raise HTTPException(
            status_code=409,
            detail="No confirmed version yet — confirm a version before checking feasibility",
        )
    project_dir = UPLOAD_ROOT / project_id
    verdict = check_feasibility(objective, store, project_id, project_dir)
    return asdict(verdict)


# ---- Production-mix planning — real, human-entered facts, independent of ---
# the confirmed process graph (no graph-version gate, unlike /train and
# /feasibility above: a Company Admin can plan production mix before, during,
# or entirely without ever building a structure graph).

_PLANNING_OBJECTIVES = (
    "maximize_profit", "maximize_revenue", "minimize_cost",
    "maximize_utilization", "maximize_throughput", "minimize_makespan",
)


class PlanProductBody(BaseModel):
    name: str
    price_per_unit: float
    cost_per_unit: float
    demand_min: float | None = None
    demand_max: float | None = None
    batch_min: float | None = None
    batch_max: float | None = None


class PlanResourceBody(BaseModel):
    name: str
    unit: str
    available_capacity: float
    kind: str | None = None


class PlanMachineBody(BaseModel):
    name: str
    available_hours: float
    utilization_floor: float | None = None
    asset_name: str | None = None


class ConsumptionCellBody(BaseModel):
    product_id: str
    resource_id: str
    per_unit: float


class SetConsumptionBody(BaseModel):
    cells: list[ConsumptionCellBody]


class CompatibilityCellBody(BaseModel):
    product_id: str
    machine_id: str
    hours_per_unit: float


class SetCompatibilityBody(BaseModel):
    cells: list[CompatibilityCellBody]


class PlanningSettingsBody(BaseModel):
    objective: str = "maximize_profit"
    demand_ceiling: bool = False
    min_committed_order: bool = False
    pooled_resources: bool = False
    batch_size: bool = False
    utilization_floor: bool = False


def _validate_plan_numbers(
    *, demand_min=None, demand_max=None, available_capacity=None, per_unit=None,
    price_per_unit=None, cost_per_unit=None, batch_min=None, batch_max=None,
    available_hours=None, utilization_floor=None, hours_per_unit=None,
):
    for label, value in (
        ("demand_min", demand_min), ("demand_max", demand_max),
        ("available_capacity", available_capacity), ("per_unit", per_unit),
        ("price_per_unit", price_per_unit), ("cost_per_unit", cost_per_unit),
        ("batch_min", batch_min), ("batch_max", batch_max),
        ("available_hours", available_hours), ("hours_per_unit", hours_per_unit),
    ):
        if value is not None and value < 0:
            raise HTTPException(status_code=400, detail=f"{label} cannot be negative")
    if demand_min is not None and demand_max is not None and demand_min > demand_max:
        raise HTTPException(status_code=400, detail="demand_min cannot exceed demand_max")
    if batch_min is not None and batch_max is not None and batch_min > batch_max:
        raise HTTPException(status_code=400, detail="batch_min cannot exceed batch_max")
    if utilization_floor is not None and not (0 <= utilization_floor <= 1):
        raise HTTPException(status_code=400, detail="utilization_floor must be between 0 and 1")


@app.get("/api/projects/{project_id}/planning/products")
def list_plan_products(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_products(project_id)


@app.post("/api/projects/{project_id}/planning/products")
def create_plan_product(project_id: str, body: PlanProductBody):
    _project_or_404(project_id)
    _validate_plan_numbers(
        demand_min=body.demand_min, demand_max=body.demand_max,
        price_per_unit=body.price_per_unit, cost_per_unit=body.cost_per_unit,
        batch_min=body.batch_min, batch_max=body.batch_max,
    )
    return db.create_plan_product(
        project_id, body.name, body.price_per_unit, body.cost_per_unit,
        body.demand_min, body.demand_max, body.batch_min, body.batch_max,
    )


@app.put("/api/projects/{project_id}/planning/products/{product_id}")
def update_plan_product(project_id: str, product_id: str, body: PlanProductBody):
    _project_or_404(project_id)
    _validate_plan_numbers(
        demand_min=body.demand_min, demand_max=body.demand_max,
        price_per_unit=body.price_per_unit, cost_per_unit=body.cost_per_unit,
        batch_min=body.batch_min, batch_max=body.batch_max,
    )
    product = db.get_plan_product(product_id)
    if not product or product["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="product not found")
    return db.update_plan_product(
        product_id, body.name, body.price_per_unit, body.cost_per_unit,
        body.demand_min, body.demand_max, body.batch_min, body.batch_max,
    )


@app.delete("/api/projects/{project_id}/planning/products/{product_id}")
def delete_plan_product(project_id: str, product_id: str):
    _project_or_404(project_id)
    product = db.get_plan_product(product_id)
    if not product or product["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="product not found")
    db.delete_plan_product(product_id)
    return {"deleted": True}


@app.get("/api/projects/{project_id}/planning/resources")
def list_plan_resources(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_resources(project_id)


@app.post("/api/projects/{project_id}/planning/resources")
def create_plan_resource(project_id: str, body: PlanResourceBody):
    _project_or_404(project_id)
    _validate_plan_numbers(available_capacity=body.available_capacity)
    return db.create_plan_resource(project_id, body.name, body.unit, body.available_capacity, body.kind)


@app.put("/api/projects/{project_id}/planning/resources/{resource_id}")
def update_plan_resource(project_id: str, resource_id: str, body: PlanResourceBody):
    _project_or_404(project_id)
    _validate_plan_numbers(available_capacity=body.available_capacity)
    resource = db.get_plan_resource(resource_id)
    if not resource or resource["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="resource not found")
    return db.update_plan_resource(resource_id, body.name, body.unit, body.available_capacity, body.kind)


@app.delete("/api/projects/{project_id}/planning/resources/{resource_id}")
def delete_plan_resource(project_id: str, resource_id: str):
    _project_or_404(project_id)
    resource = db.get_plan_resource(resource_id)
    if not resource or resource["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="resource not found")
    db.delete_plan_resource(resource_id)
    return {"deleted": True}


@app.get("/api/projects/{project_id}/planning/machines")
def list_plan_machines(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_machines(project_id)


@app.post("/api/projects/{project_id}/planning/machines")
def create_plan_machine(project_id: str, body: PlanMachineBody):
    _project_or_404(project_id)
    _validate_plan_numbers(available_hours=body.available_hours, utilization_floor=body.utilization_floor)
    return db.create_plan_machine(project_id, body.name, body.available_hours, body.utilization_floor, body.asset_name)


@app.put("/api/projects/{project_id}/planning/machines/{machine_id}")
def update_plan_machine(project_id: str, machine_id: str, body: PlanMachineBody):
    _project_or_404(project_id)
    _validate_plan_numbers(available_hours=body.available_hours, utilization_floor=body.utilization_floor)
    machine = db.get_plan_machine(machine_id)
    if not machine or machine["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="machine not found")
    return db.update_plan_machine(machine_id, body.name, body.available_hours, body.utilization_floor, body.asset_name)


@app.delete("/api/projects/{project_id}/planning/machines/{machine_id}")
def delete_plan_machine(project_id: str, machine_id: str):
    _project_or_404(project_id)
    machine = db.get_plan_machine(machine_id)
    if not machine or machine["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="machine not found")
    db.delete_plan_machine(machine_id)
    return {"deleted": True}


@app.get("/api/projects/{project_id}/planning/consumption")
def get_plan_consumption(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_consumption(project_id)


@app.put("/api/projects/{project_id}/planning/consumption")
def put_plan_consumption(project_id: str, body: SetConsumptionBody):
    _project_or_404(project_id)
    product_ids = {p["id"] for p in db.list_plan_products(project_id)}
    resource_ids = {r["id"] for r in db.list_plan_resources(project_id)}
    seen = set()
    for cell in body.cells:
        _validate_plan_numbers(per_unit=cell.per_unit)
        if cell.product_id not in product_ids:
            raise HTTPException(status_code=400, detail=f"unknown product_id {cell.product_id!r} for this project")
        if cell.resource_id not in resource_ids:
            raise HTTPException(status_code=400, detail=f"unknown resource_id {cell.resource_id!r} for this project")
        key = (cell.product_id, cell.resource_id)
        if key in seen:
            raise HTTPException(status_code=400, detail=f"duplicate cell for product/resource pair {key!r}")
        seen.add(key)
    db.set_plan_consumption(project_id, [c.model_dump() for c in body.cells])
    return db.list_plan_consumption(project_id)


@app.get("/api/projects/{project_id}/planning/machine-compatibility")
def get_plan_machine_compatibility(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_machine_compatibility(project_id)


@app.put("/api/projects/{project_id}/planning/machine-compatibility")
def put_plan_machine_compatibility(project_id: str, body: SetCompatibilityBody):
    _project_or_404(project_id)
    product_ids = {p["id"] for p in db.list_plan_products(project_id)}
    machine_ids = {m["id"] for m in db.list_plan_machines(project_id)}
    seen = set()
    for cell in body.cells:
        _validate_plan_numbers(hours_per_unit=cell.hours_per_unit)
        if cell.hours_per_unit <= 0:
            raise HTTPException(status_code=400, detail="hours_per_unit must be positive — omit the cell to express incompatibility")
        if cell.product_id not in product_ids:
            raise HTTPException(status_code=400, detail=f"unknown product_id {cell.product_id!r} for this project")
        if cell.machine_id not in machine_ids:
            raise HTTPException(status_code=400, detail=f"unknown machine_id {cell.machine_id!r} for this project")
        key = (cell.product_id, cell.machine_id)
        if key in seen:
            raise HTTPException(status_code=400, detail=f"duplicate cell for product/machine pair {key!r}")
        seen.add(key)
    db.set_plan_machine_compatibility(project_id, [c.model_dump() for c in body.cells])
    return db.list_plan_machine_compatibility(project_id)


def _resolve_planning_settings(project_id: str) -> dict:
    raw = db.get_settings(project_id)
    return {
        "objective": raw.get("planning.objective", "maximize_profit"),
        "toggles": {
            "demand_ceiling": raw.get("planning.constraint.demand_ceiling", "false") == "true",
            "min_committed_order": raw.get("planning.constraint.min_committed_order", "false") == "true",
            "pooled_resources": raw.get("planning.constraint.pooled_resources", "false") == "true",
            "batch_size": raw.get("planning.constraint.batch_size", "false") == "true",
            "utilization_floor": raw.get("planning.constraint.utilization_floor", "false") == "true",
        },
    }


@app.get("/api/projects/{project_id}/planning/settings")
def get_planning_settings(project_id: str):
    _project_or_404(project_id)
    resolved = _resolve_planning_settings(project_id)
    return {"objective": resolved["objective"], **resolved["toggles"]}


@app.put("/api/projects/{project_id}/planning/settings")
def put_planning_settings(project_id: str, body: PlanningSettingsBody):
    _project_or_404(project_id)
    if body.objective not in _PLANNING_OBJECTIVES:
        raise HTTPException(status_code=400, detail=f"objective must be one of {_PLANNING_OBJECTIVES}")
    db.set_setting(project_id, "planning.objective", body.objective)
    for key, value in (
        ("planning.constraint.demand_ceiling", body.demand_ceiling),
        ("planning.constraint.min_committed_order", body.min_committed_order),
        ("planning.constraint.pooled_resources", body.pooled_resources),
        ("planning.constraint.batch_size", body.batch_size),
        ("planning.constraint.utilization_floor", body.utilization_floor),
    ):
        db.set_setting(project_id, key, "true" if value else "false")
    resolved = _resolve_planning_settings(project_id)
    return {"objective": resolved["objective"], **resolved["toggles"]}


def _primary_downtime_estimate(project_id: str, machine: dict) -> float | None:
    """Dormant hook. Always returns None today. Once a project has real
    historical failure-event-log data, this would look up a succeeded
    training run for a dedicated objective (e.g. "machine_failure_risk") and
    convert its predicted failure-probability/RUL-hours output for this
    machine into a downtime-hours number — reusing computation_engine's
    existing train_supervised mechanism, the same way any other labeled
    prediction already does. Not built now: no real historical failure-event
    data exists anywhere in this codebase to label a model with yet."""
    return None


def _apply_downtime(project_id: str, machine: dict) -> dict:
    """Two-tier, always automatic, never blocking: real prediction if it
    exists (dormant today), else a rough 0%/15%/30% capacity cut derived from
    the maintenance objective's own already-computed per-machine drift
    status — never a fabricated probability. No machine ever loses capacity
    for a reason nobody can trace back to real data."""
    primary = _primary_downtime_estimate(project_id, machine)
    if primary is not None:
        return {**machine, "downtime_hours": primary, "downtime_tier": "primary"}

    if not machine.get("asset_name"):
        return {**machine, "downtime_hours": 0.0, "downtime_tier": "none"}

    maint_result = _latest_succeeded_result(project_id, "maintenance")
    if not maint_result:
        return {**machine, "downtime_hours": 0.0, "downtime_tier": "none"}

    signal_asset_map = {s: a for a, sigs in store.signals_by_asset(project_id).items() for s in sigs}
    card = summarize_maintenance({"result": maint_result}, signal_asset_map)
    machine_entry = next((m for m in card.data.get("machines", []) if m["item_id"] == machine["asset_name"]), None)
    if machine_entry is None:
        return {**machine, "downtime_hours": 0.0, "downtime_tier": "none"}

    worst_frac = max(
        (
            it["frac"] for it in card.data.get("items", [])
            if signal_asset_map.get(it["item_id"]) == machine["asset_name"]
        ),
        default=0.0,
    )
    fraction = 0.0 if machine_entry["status"] == "ok" else (0.15 if worst_frac < 0.5 else 0.30)
    return {
        **machine, "downtime_hours": fraction * machine["available_hours"], "downtime_tier": "fallback",
    }


def _estimate_defect_rate(project_id: str) -> tuple[float, dict | None]:
    """Same two-tier honesty as downtime. A real predicted-defect-rate model
    doesn't exist either — the 'quality' objective is the same drift-detection
    forecast as maintenance, not a defect-rate regression. Derives one
    project-wide rough estimate from the worst currently-drifting quality
    signal, using the exact same 0%/15%/30% buckets as downtime — no reason
    to invent a second set of thresholds."""
    quality_result = _latest_succeeded_result(project_id, "quality")
    if not quality_result:
        return 0.0, None
    card = summarize_deviation("quality", {"result": quality_result}, unit_word="day", item_word="quality signal")
    items = card.data.get("items", [])
    if not items:
        return 0.0, None
    worst = max(items, key=lambda it: it["frac"])
    if worst["status"] == "ok":
        return 0.0, None
    fraction = 0.15 if worst["frac"] < 0.5 else 0.30
    return fraction, {"worst_signal": worst["item_id"], "frac": worst["frac"], "estimated_defect_rate": fraction}


@app.post("/api/projects/{project_id}/planning/solve")
def solve_plan(project_id: str):
    _project_or_404(project_id)
    products = db.list_plan_products(project_id)
    machines = db.list_plan_machines(project_id)
    resources = db.list_plan_resources(project_id)
    compatibility_rows = db.list_plan_machine_compatibility(project_id)
    consumption_rows = db.list_plan_consumption(project_id)
    compatibility = {(c["product_id"], c["machine_id"]): c["hours_per_unit"] for c in compatibility_rows}
    consumption = {(c["product_id"], c["resource_id"]): c["per_unit"] for c in consumption_rows}

    settings = _resolve_planning_settings(project_id)
    machines_with_downtime = [_apply_downtime(project_id, m) for m in machines]
    defect_rate, defect_detail = _estimate_defect_rate(project_id)

    try:
        outcome = solve_production_mix(
            products, machines_with_downtime, resources, compatibility, consumption,
            objective=settings["objective"], toggles=settings["toggles"], defect_rate=defect_rate,
        )
    except Exception as exc:  # noqa: BLE001 — the run row is the error channel
        outcome = {"verdict": "error", "message": str(exc)}

    return db.create_plan_run(
        project_id, status=outcome["verdict"],
        result={
            "inputs": {
                "products": products, "machines": machines_with_downtime, "resources": resources,
                "compatibility": compatibility_rows, "consumption": consumption_rows,
                "settings": settings, "defect_detail": defect_detail,
            },
            "output": outcome,
        },
        total_profit=outcome.get("objective_value") if settings["objective"] == "maximize_profit" else None,
        objective=settings["objective"], objective_value=outcome.get("objective_value"),
    )


@app.get("/api/projects/{project_id}/planning/runs")
def list_plan_runs(project_id: str):
    _project_or_404(project_id)
    return db.list_plan_runs(project_id)


@app.get("/api/projects/{project_id}/planning/runs/{run_id}")
def get_plan_run(project_id: str, run_id: str):
    _project_or_404(project_id)
    run = db.get_plan_run(run_id)
    if not run or run["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="plan run not found")
    return run


# ---- Computation Engine (C) -------------------------------------------------

MODEL_ROOT = Path(__file__).parent / "models"

# How long AutoGluon may train per objective. It's a bound, not a target — AutoGluon
# returns as soon as it's done, so a small dataset finishes fast regardless. Bigger
# datasets need a bigger budget or they get cut short, so it's a per-project setting
# (key below); 30 min is a sane default. Set it to 0 in settings for no limit (only
# when you accept a run may take a very long time and hold the queue).
_TRAINING_TIME_LIMIT_KEY = "computation.time_limit_seconds"
_DEFAULT_TRAINING_TIME_LIMIT = 1800  # 30 minutes


def _resolve_training_time_limit(project_id: str) -> int | None:
    raw = db.get_settings(project_id).get(_TRAINING_TIME_LIMIT_KEY)
    if raw is None or str(raw).strip() == "":
        return _DEFAULT_TRAINING_TIME_LIMIT
    try:
        seconds = int(float(raw))
    except (TypeError, ValueError):
        return _DEFAULT_TRAINING_TIME_LIMIT
    return None if seconds <= 0 else seconds  # 0 / negative = no limit


# Queued runs execute one at a time: AutoGluon already parallelizes across
# every CPU core internally, so two trainings at once don't finish sooner —
# they just fight for the same cores and memory. The queue gives the user
# "click all six and walk away"; the lock keeps the machine responsive.
_TRAINING_LOCK = threading.Lock()


def _latest_succeeded_result(project_id: str, objective: str) -> dict | None:
    for row in db.list_training_runs(project_id, objective):
        if row["status"] == "succeeded":
            full = db.get_training_run(row["id"])
            return full["result"] if full else None
    return None


def _execute_training_run(run_id: str, project_id: str, objective: str, model_dir: Path):
    # Runs in Starlette's background threadpool after the response is sent.
    # Heavy imports stay inside computation_engine so A/B endpoints never pay
    # for them; every failure lands in the run row verbatim — a failed run is
    # a visible, inspectable outcome, not a swallowed exception.
    from computation_engine.runner import ObjectiveNotSupported, run_training

    with _TRAINING_LOCK:
        db.update_training_run(run_id, status="running")
        try:
            # B gates C here, inside the run, so the start endpoint stays
            # instant. If the objective isn't worth attempting, that's an honest
            # "not applicable" verdict, not a failure.
            verdict = check_feasibility(objective, store, project_id, UPLOAD_ROOT / project_id)
            if not verdict.attemptable:
                raise ObjectiveNotSupported(verdict.reason)

            graph_context = None
            if objective == "scheduling":
                # Optional: lets predicted maintenance windows block the plan when a
                # completed Machine Health run already exists for this project. Absent
                # one, scheduling behaves exactly as it did before this feature existed.
                from scheduling_engine.solver import GraphMaintenanceContext

                graph_context = GraphMaintenanceContext(
                    store=store,
                    project_id=project_id,
                    maintenance_result=_latest_succeeded_result(project_id, "maintenance"),
                )

            outcome = run_training(
                objective=objective,
                supporting_signals=[asdict(s) for s in verdict.supporting_signals],
                upload_dir=UPLOAD_ROOT / project_id,
                model_dir=model_dir,
                time_limit=_resolve_training_time_limit(project_id),
                settings=db.get_settings(project_id),
                graph_context=graph_context,
            )
            db.update_training_run(
                run_id,
                status="succeeded",
                task_type=outcome.task_type,
                decision_reasoning=outcome.decision_reasoning,
                result=outcome.result,
                finished=True,
            )
        except ObjectiveNotSupported as exc:
            # An honest "can't do this with the current data" — a normal outcome,
            # not a failure, so it shows grey "not applicable" rather than red.
            db.update_training_run(run_id, status="unsupported", error=str(exc), finished=True)
        except Exception as exc:  # noqa: BLE001 — the run row is the error channel
            db.update_training_run(run_id, status="failed", error=str(exc), finished=True)


# Every objective the platform knows — the same six the operator dashboard and the
# "Train all" button use. Each run still gates itself on feasibility, so queuing all
# of them just means "train whatever the data now supports".
_ALL_OBJECTIVES = ("maintenance", "quality", "demand_forecast", "delivery_date", "inventory", "scheduling")


def _train_all_objectives(project_id: str) -> None:
    """Kick off a fresh run for every objective, in place (caller is already a
    background thread; the runs serialize on _TRAINING_LOCK anyway). Used after an
    auto-confirmed structure change so the whole factory's predictions refresh
    against the new graph — nothing here bypasses feasibility."""
    versions = db.list_versions(project_id)
    if not versions:
        return
    for objective in _ALL_OBJECTIVES:
        if db.has_active_training_run(project_id, objective):
            continue
        run_id = str(uuid.uuid4())
        model_dir = MODEL_ROOT / project_id / run_id
        db.create_training_run(
            project_id, version_number=versions[0]["version_number"],
            objective=objective, model_path=str(model_dir), run_id=run_id,
        )
        _execute_training_run(run_id, project_id, objective, model_dir)


class StartTrainingRequest(BaseModel):
    objective: str = "maintenance"


@app.post("/api/projects/{project_id}/train")
def start_training(project_id: str, body: StartTrainingRequest, background_tasks: BackgroundTasks):
    _project_or_404(project_id)
    versions = db.list_versions(project_id)
    if not versions:
        raise HTTPException(
            status_code=409,
            detail="No confirmed version yet — training only ever runs against a confirmed graph",
        )
    # Only the SAME objective twice at once is a duplicate — all six
    # objectives may queue side by side and execute in turn.
    if db.has_active_training_run(project_id, body.objective):
        raise HTTPException(
            status_code=409,
            detail=f"A training run for {body.objective!r} is already queued or running",
        )

    run_id = str(uuid.uuid4())
    model_dir = MODEL_ROOT / project_id / run_id
    run = db.create_training_run(
        project_id,
        version_number=versions[0]["version_number"],
        objective=body.objective,
        model_path=str(model_dir),
        run_id=run_id,
    )
    background_tasks.add_task(_execute_training_run, run_id, project_id, body.objective, model_dir)
    return run


@app.get("/api/projects/{project_id}/training-runs")
def list_training_runs(project_id: str, objective: str | None = None):
    _project_or_404(project_id)
    return db.list_training_runs(project_id, objective=objective)


@app.get("/api/projects/{project_id}/training-runs/{run_id}")
def get_training_run(project_id: str, run_id: str):
    _project_or_404(project_id)
    run = db.get_training_run(run_id)
    if not run or run["project_id"] != project_id:
        raise HTTPException(status_code=404, detail="training run not found")
    return run


# ---- Decision Layer (D) — real-data dashboard ------------------------------

_OBJECTIVE_LABELS = {
    "maintenance": "Machine health",
    "quality": "Quality",
    "demand_forecast": "Demand",
    "delivery_date": "Deliveries",
    "inventory": "Materials",
    "scheduling": "Production plan",
}


def _card_for_objective(project_id: str, objective: str) -> dict:
    runs = db.list_training_runs(project_id, objective=objective)
    latest_done = next((r for r in runs if r["status"] == "succeeded"), None)
    latest_failed = next((r for r in runs if r["status"] == "failed"), None) if not latest_done else None
    active = next((r for r in runs if r["status"] in ("queued", "running")), None)

    base = {"objective": objective, "label": _OBJECTIVE_LABELS[objective]}

    if active:
        return {**base, "status": "pending", "headline": "Checking now…", "facts": [],
                "data": {}, "actions": [], "run_id": active["id"]}

    if not latest_done:
        if latest_failed:
            return {**base, "status": "info", "headline": "Not attemptable with the current data yet.",
                    "facts": [db.get_training_run(latest_failed["id"])["error"]],
                    "data": {}, "actions": [], "run_id": latest_failed["id"]}
        return {**base, "status": "info", "headline": "Not checked yet.", "facts": [],
                "data": {}, "actions": [], "run_id": None}

    run = db.get_training_run(latest_done["id"])
    settings = db.get_settings(project_id) if objective == "inventory" else None
    upload_dir = UPLOAD_ROOT / project_id if objective == "delivery_date" else None
    signal_asset_map = None
    if objective == "maintenance":
        # Invert asset -> [signals] into signal -> asset: what the maintenance
        # card needs is "which machine does THIS signal belong to", straight
        # from the confirmed graph's own MEASURES links — never guessed.
        signal_asset_map = {
            signal: asset for asset, signals in store.signals_by_asset(project_id).items() for signal in signals
        }
    try:
        card: Card = SUMMARIZERS[objective](run, settings=settings, upload_dir=upload_dir, signal_asset_map=signal_asset_map)
    except Exception as exc:  # noqa: BLE001 — surface narration failures honestly, never silently
        return {**base, "status": "error", "headline": "Could not summarize the latest result.",
                "facts": [str(exc)], "data": {}, "actions": [], "run_id": run["id"]}

    return {
        **base, "status": card.status, "headline": card.headline, "facts": card.facts,
        "data": card.data, "actions": card.actions, "run_id": run["id"],
        "checked_at": run.get("finished_at"),
    }


@app.get("/api/projects/{project_id}/dashboard")
def get_dashboard(project_id: str):
    _project_or_404(project_id)
    if not db.list_versions(project_id):
        raise HTTPException(status_code=409, detail="No confirmed version yet")
    return [_card_for_objective(project_id, obj) for obj in _OBJECTIVE_LABELS]


# ---- Delivery quoting — on-demand estimate for a brand-new, not-yet-placed
# order. Derived from the delivery_date objective's already-verified label
# (never re-asks that question), reusing the same training_runs table under
# its own objective name — no schema change, no new run-lifecycle code.
_QUOTE_OBJECTIVE = "delivery_date_quote"


def _execute_quote_training(run_id: str, project_id: str, model_dir: Path):
    from computation_engine.quoting import train_quote_model
    from computation_engine.task_detection import build_file_catalog

    with _TRAINING_LOCK:
        db.update_training_run(run_id, status="running")
        try:
            base_runs = db.list_training_runs(project_id, objective="delivery_date")
            base_run_summary = next((r for r in base_runs if r["status"] == "succeeded"), None)
            if not base_run_summary:
                raise ValueError(
                    "No successful 'Delivery date' training run yet — train that objective first; "
                    "quoting reuses its already-verified label rather than re-deciding one."
                )
            base_run = db.get_training_run(base_run_summary["id"])
            base_params = base_run["result"]["params"]
            label_file = base_params.get("label_file")
            label_column = base_params.get("label_column")
            if not label_file or not label_column:
                raise ValueError(
                    "The existing 'Delivery date' run predates this feature and doesn't record which "
                    "file/column it used — retrain 'Delivery date' once, then retry."
                )

            upload_dir = UPLOAD_ROOT / project_id
            catalogs = build_file_catalog(upload_dir)
            catalog = next((c for c in catalogs if c.filename == label_file), None)
            if catalog is None:
                raise ValueError(f"{label_file!r} is no longer present among the uploaded files")

            result = train_quote_model(
                upload_dir=upload_dir, label_file=label_file, label_column=label_column,
                label_file_catalog=catalog, model_dir=model_dir,
            )
            db.update_training_run(
                run_id, status="succeeded", task_type=result["task_type"],
                decision_reasoning=(
                    f"Reused the label from the confirmed 'Delivery date' run ({label_file!r} / "
                    f"{label_column!r}). Excluded as not knowable before a new order is placed: "
                    f"{result['params']['excluded_columns']!r}."
                ),
                result=result, finished=True,
            )
        except Exception as exc:  # noqa: BLE001 — the run row is the error channel
            db.update_training_run(run_id, status="failed", error=str(exc), finished=True)


@app.post("/api/projects/{project_id}/objectives/delivery_date/quote-model/train")
def start_quote_training(project_id: str, background_tasks: BackgroundTasks):
    _project_or_404(project_id)
    versions = db.list_versions(project_id)
    if not versions:
        raise HTTPException(status_code=409, detail="No confirmed version yet")
    if db.has_active_training_run(project_id, _QUOTE_OBJECTIVE):
        raise HTTPException(status_code=409, detail="Quote model training is already queued or running")

    run_id = str(uuid.uuid4())
    model_dir = MODEL_ROOT / project_id / run_id
    run = db.create_training_run(
        project_id, version_number=versions[0]["version_number"],
        objective=_QUOTE_OBJECTIVE, model_path=str(model_dir), run_id=run_id,
    )
    background_tasks.add_task(_execute_quote_training, run_id, project_id, model_dir)
    return run


@app.get("/api/projects/{project_id}/objectives/delivery_date/quote-model")
def get_quote_model_status(project_id: str):
    _project_or_404(project_id)
    runs = db.list_training_runs(project_id, objective=_QUOTE_OBJECTIVE)
    active = next((r for r in runs if r["status"] in ("queued", "running")), None)
    if active:
        return {"status": "pending", "run_id": active["id"]}

    latest_done = next((r for r in runs if r["status"] == "succeeded"), None)
    if latest_done:
        run = db.get_training_run(latest_done["id"])
        p = run["result"]["params"]
        return {
            "status": "ready", "run_id": run["id"],
            "feature_columns": p["feature_columns"], "excluded_columns": p["excluded_columns"],
            "reference_date_column": p.get("reference_date_column"),
        }

    latest_failed = next((r for r in runs if r["status"] == "failed"), None)
    if latest_failed:
        run = db.get_training_run(latest_failed["id"])
        return {"status": "failed", "run_id": run["id"], "error": run["error"]}

    return {"status": "untrained"}


class QuoteRequest(BaseModel):
    inputs: dict[str, str]


@app.post("/api/projects/{project_id}/objectives/delivery_date/quote")
def get_quote(project_id: str, body: QuoteRequest):
    _project_or_404(project_id)
    from computation_engine.quoting import predict_quote

    runs = db.list_training_runs(project_id, objective=_QUOTE_OBJECTIVE)
    latest_done = next((r for r in runs if r["status"] == "succeeded"), None)
    if not latest_done:
        raise HTTPException(status_code=409, detail="No trained quote model yet — train it first")

    run = db.get_training_run(latest_done["id"])
    p = run["result"]["params"]
    try:
        result = predict_quote(
            Path(run["model_path"]), p["feature_columns"], p.get("reference_date_column"), body.inputs
        )
    except Exception as exc:  # noqa: BLE001 — a bad/missing field is a 400, not a 500
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result
