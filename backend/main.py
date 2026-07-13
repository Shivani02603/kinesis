"""FastAPI surface over the Understanding Engine.

Every route is a thin wrapper: parse request -> call understanding_engine
(pure logic) or db (persistence) -> return JSON. No business logic lives here
beyond wiring the two together and translating human review actions (confirm/
reject/needs_fix) into the actual Neo4j merge that a "confirm" implies.
"""

import sys
import threading
import uuid
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(override=True)

sys.path.insert(0, str(Path(__file__).parent.parent))

from understanding_engine.feasibility import check_feasibility  # noqa: E402
from understanding_engine.graph_store import GraphStore  # noqa: E402
from understanding_engine.pipeline import run_pipeline  # noqa: E402
from decision_layer.narration import SUMMARIZERS, Card  # noqa: E402

from . import db  # noqa: E402

UPLOAD_ROOT = Path(__file__).parent / "uploads"

store: GraphStore | None = None


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


class CreateProjectRequest(BaseModel):
    name: str


class ResolveReviewItemRequest(BaseModel):
    resolution: str  # "confirmed" | "rejected" | "needs_fix"


def _project_or_404(project_id: str) -> dict:
    project = db.get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


@app.post("/api/projects")
def create_project(body: CreateProjectRequest):
    project = db.create_project(body.name)
    (UPLOAD_ROOT / project["id"]).mkdir(parents=True, exist_ok=True)
    return project


@app.get("/api/projects")
def list_projects():
    projects = db.list_projects()
    for p in projects:
        p["pending_review_count"] = db.pending_count(p["id"])
    return projects


@app.get("/api/projects/{project_id}")
def get_project(project_id: str):
    project = _project_or_404(project_id)
    project["pending_review_count"] = db.pending_count(project_id)
    return project


@app.post("/api/projects/{project_id}/upload")
async def upload_files(project_id: str, files: list[UploadFile]):
    _project_or_404(project_id)
    project_dir = UPLOAD_ROOT / project_id
    project_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for f in files:
        dest = project_dir / f.filename
        dest.write_bytes(await f.read())
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


@app.post("/api/projects/{project_id}/run")
def run(project_id: str):
    _project_or_404(project_id)
    project_dir = UPLOAD_ROOT / project_id
    all_filenames = [p.name for p in project_dir.iterdir() if p.is_file()] if project_dir.exists() else []
    new_filenames = db.get_unprocessed_filenames(project_id, all_filenames)
    if not new_filenames:
        return {"message": "no new files to process", "processed": []}

    decided = db.get_decided_state(project_id)
    result = run_pipeline(
        project_id=project_id,
        source_paths=[project_dir / f for f in new_filenames],
        store=store,
        known_merge_pairs=decided["known_merge_pairs"],
        known_distinct_pairs=decided["known_distinct_pairs"],
        acknowledged_gap_ids=decided["acknowledged_gap_ids"],
        acknowledged_orphan_ids=decided["acknowledged_orphan_ids"],
    )
    db.mark_processed(project_id, new_filenames)

    db.sync_review_items(
        project_id,
        "ambiguous_merge",
        [asdict(m) for m in result.ambiguous_merge_queue],
    )
    db.sync_review_items(project_id, "stage_gap", [asdict(g) for g in result.stage_gaps])
    db.sync_review_items(project_id, "orphan", [asdict(o) for o in result.orphans])
    db.sync_review_items(project_id, "conflict", [asdict(c) for c in result.conflicts])

    return {
        "processed": new_filenames,
        "resolution_log": result.resolution_log,
        "pending_review_count": db.pending_count(project_id),
    }


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
    return db.confirm_version(project_id, snapshot)


@app.get("/api/projects/{project_id}/versions")
def list_versions(project_id: str):
    _project_or_404(project_id)
    return db.list_versions(project_id)


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


# ---- Computation Engine (C) -------------------------------------------------

MODEL_ROOT = Path(__file__).parent / "models"


# Queued runs execute one at a time: AutoGluon already parallelizes across
# every CPU core internally, so two trainings at once don't finish sooner —
# they just fight for the same cores and memory. The queue gives the user
# "click all six and walk away"; the lock keeps the machine responsive.
_TRAINING_LOCK = threading.Lock()


def _execute_training_run(run_id: str, project_id: str, objective: str, model_dir: Path):
    # Runs in Starlette's background threadpool after the response is sent.
    # Heavy imports stay inside computation_engine so A/B endpoints never pay
    # for them; every failure lands in the run row verbatim — a failed run is
    # a visible, inspectable outcome, not a swallowed exception.
    from computation_engine.runner import run_training

    with _TRAINING_LOCK:
        db.update_training_run(run_id, status="running")
        try:
            # B gates C here, inside the run, so the start endpoint stays
            # instant: if the objective isn't worth attempting the run fails
            # visibly with feasibility's own reason, not a swallowed skip.
            verdict = check_feasibility(objective, store, project_id, UPLOAD_ROOT / project_id)
            if not verdict.attemptable:
                raise ValueError(f"Feasibility says not attemptable: {verdict.reason}")

            outcome = run_training(
                objective=objective,
                supporting_signals=[asdict(s) for s in verdict.supporting_signals],
                upload_dir=UPLOAD_ROOT / project_id,
                model_dir=model_dir,
            )
            db.update_training_run(
                run_id,
                status="succeeded",
                task_type=outcome.task_type,
                decision_reasoning=outcome.decision_reasoning,
                result=outcome.result,
                finished=True,
            )
        except Exception as exc:  # noqa: BLE001 — the run row is the error channel
            db.update_training_run(run_id, status="failed", error=str(exc), finished=True)


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
    try:
        card: Card = SUMMARIZERS[objective](run, settings=settings, upload_dir=upload_dir)
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
