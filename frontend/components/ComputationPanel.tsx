"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  OBJECTIVES,
  type FeasibilityVerdict,
  type TrainingResult,
  type TrainingRun,
} from "@/lib/api";
import { ForecastChart } from "./ForecastChart";

const POLL_MS = 4000;

const STATUS_BADGES: Record<TrainingRun["status"], { label: string; cls: string }> = {
  queued: { label: "queued", cls: "badge-pending" },
  running: { label: "training…", cls: "badge-pending" },
  succeeded: { label: "trained", cls: "badge-confirmed" },
  failed: { label: "failed", cls: "badge-rejected" },
};

const TASK_TYPE_EXPLANATIONS: Record<string, string> = {
  forecasting:
    "No recorded outcome events relevant to this objective were found in the uploaded data, so the system models each relevant signal's own behavior over time. The shaded band is the normal range learned from its own history — readings outside it indicate a deviation from past behavior.",
  supervised:
    "Recorded outcome labels relevant to this objective were found in the uploaded data, so the system trained a supervised model to predict them directly.",
  scheduling:
    "This objective is a planning decision, not a prediction — so instead of training a model, the system solved for the schedule exactly with a constraint solver (OR-Tools CP-SAT), minimizing lateness against due dates first and total duration second.",
};

const GANTT_COLORS = ["#a85a2b", "#5b7c99", "#7c9c6b", "#9c6b8f", "#b0893c", "#6b9c95"];

function ScheduleView({ result }: { result: TrainingResult }) {
  const orders = result.orders ?? [];
  const machines = result.machines ?? [];
  const makespan = result.makespan_hours || 1;
  const colorOf = (machine: string) => GANTT_COLORS[machines.indexOf(machine) % GANTT_COLORS.length];

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Schedule summary</h3>
          <span className="badge">{result.solver_status}</span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1 text-xs">
          <div>
            <dt className="text-[var(--text-faint)]">starts</dt>
            <dd className="font-medium">{result.schedule_start ? new Date(result.schedule_start).toLocaleString() : "—"}</dd>
          </div>
          <div>
            <dt className="text-[var(--text-faint)]">everything done in</dt>
            <dd className="font-medium">{result.makespan_hours} hours</dd>
          </div>
          <div>
            <dt className="text-[var(--text-faint)]">on time</dt>
            <dd className="font-medium">{result.orders_on_time} of {orders.length} orders</dd>
          </div>
          <div>
            <dt className="text-[var(--text-faint)]">total lateness</dt>
            <dd className="font-medium">{result.total_hours_late} hours</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-3 pt-1 text-xs text-[var(--text-muted)]">
          {machines.map((m) => (
            <span key={m} className="flex items-center gap-1.5">
              <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: colorOf(m) }} />
              {m}
            </span>
          ))}
        </div>
      </div>

      <div className="card p-4 space-y-3">
        <h3 className="text-sm font-semibold">Order-by-order plan</h3>
        {orders.map((o) => (
          <div key={o.order_id} className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span>
                <span className="font-medium">{o.order_id}</span>
                <span className="text-[var(--text-faint)]"> — {o.quantity} units</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-[var(--text-faint)]">
                  done {new Date(o.completion).toLocaleString()} · due {new Date(o.due_date).toLocaleDateString()}
                </span>
                <span className={`badge ${o.on_time ? "badge-confirmed" : "badge-rejected"}`}>
                  {o.on_time ? "on time" : `${o.hours_late}h late`}
                </span>
              </span>
            </div>
            <div className="relative h-5 rounded bg-[var(--surface)] border border-[var(--border)] overflow-hidden">
              {o.tasks.map((t) => (
                <div
                  key={`${o.order_id}-${t.machine}`}
                  className="absolute top-0 h-full"
                  title={`${t.machine}: ${new Date(t.start).toLocaleString()} → ${new Date(t.end).toLocaleString()}`}
                  style={{
                    left: `${(t.start_h / makespan) * 100}%`,
                    width: `${Math.max(0.5, ((t.end_h - t.start_h) / makespan) * 100)}%`,
                    background: colorOf(t.machine),
                    opacity: 0.85,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-[var(--text-faint)]">
          Each row is one order; colored segments show its time on each machine, left to right across
          the full {result.makespan_hours}-hour schedule. Hover a segment for exact times.
        </p>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TrainingRun["status"] }) {
  const s = STATUS_BADGES[status];
  return <span className={`badge ${s.cls}`}>{s.label}</span>;
}

function ParamsGrid({ params }: { params: Record<string, unknown> }) {
  const entries = Object.entries(params).filter(([, v]) => typeof v !== "object" || v === null);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-2">
          <dt className="text-[var(--text-faint)]">{k.replaceAll("_", " ")}</dt>
          <dd className="font-mono text-[var(--text-muted)]">{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

function Leaderboard({ run }: { run: TrainingRun }) {
  const result = run.result;
  if (!result?.leaderboard) return null;
  return (
    <div className="card p-4 space-y-2">
      <h3 className="text-sm font-semibold">Model selection</h3>
      <p className="text-xs text-[var(--text-faint)]">
        Every model AutoGluon tried, scored on held-out validation data — the best one was selected
        empirically, not by any preset rule. Metric: {result.eval_metric}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--text-faint)] border-b border-[var(--border)]">
              <th className="py-1.5 pr-4 font-medium">Model</th>
              <th className="py-1.5 pr-4 font-medium">Validation score</th>
              <th className="py-1.5 pr-4 font-medium">Fit time (s)</th>
            </tr>
          </thead>
          <tbody>
            {result.leaderboard!.map((m) => {
              const isBest = m.model === result.best_model;
              return (
                <tr
                  key={m.model}
                  className={`border-b border-[var(--border)] last:border-0 ${isBest ? "font-semibold" : ""}`}
                >
                  <td className="py-1.5 pr-4">
                    {m.model}
                    {isBest && <span className="badge badge-confirmed ml-2">selected</span>}
                  </td>
                  <td className="py-1.5 pr-4 font-mono">{m.score_val ?? "—"}</td>
                  <td className="py-1.5 pr-4 font-mono">{m.fit_time ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RunDetail({ run }: { run: TrainingRun }) {
  if (run.status === "failed") {
    return (
      <div className="card p-4 border-[var(--danger)] space-y-1">
        <h3 className="text-sm font-semibold text-[var(--danger)]">Training failed</h3>
        <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{run.error}</p>
        <p className="text-xs text-[var(--text-faint)]">
          Failures are reported verbatim — nothing is retried or masked silently.
        </p>
      </div>
    );
  }

  if (run.status === "queued" || run.status === "running") {
    return (
      <div className="card p-4 flex items-center gap-3">
        <span className="inline-block h-3 w-3 rounded-full bg-[var(--accent,#8b5e3c)] animate-pulse" />
        <div>
          <p className="text-sm font-medium">
            {run.status === "queued" ? "Queued — starting shortly" : "Training in progress"}
          </p>
          <p className="text-xs text-[var(--text-faint)]">
            AutoGluon is trying multiple model families and validating each on held-out data.
            This updates automatically.
          </p>
        </div>
      </div>
    );
  }

  const result = run.result;
  if (!result) return null;

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">How the system decided</h3>
          <span className="badge">{result.task_type}</span>
        </div>
        {run.decision_reasoning && (
          <p className="text-xs text-[var(--text-muted)]">
            <span className="font-medium text-[var(--text)]">Reasoning: </span>
            {run.decision_reasoning}
          </p>
        )}
        <p className="text-xs text-[var(--text-faint)]">{TASK_TYPE_EXPLANATIONS[result.task_type]}</p>
        <div className="pt-2 border-t border-[var(--border)]">
          <ParamsGrid params={result.params} />
        </div>
      </div>

      {result.task_type === "scheduling" && <ScheduleView result={result} />}

      <Leaderboard run={run} />

      {result.series?.map((s) => (
        <div key={s.item_id} className="card p-4 space-y-1">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold">{s.item_id}</h3>
            <span className="text-xs text-[var(--text-faint)]">
              solid: recorded readings · dashed: forecast · shaded: learned normal range (q10–q90)
            </span>
          </div>
          <ForecastChart series={s} />
        </div>
      ))}

      {result.feature_importance && (
        <div className="card p-4 space-y-2">
          <h3 className="text-sm font-semibold">What drives the prediction</h3>
          <ul className="text-xs space-y-1">
            {result.feature_importance.map((f) => (
              <li key={f.feature} className="flex justify-between">
                <span>{f.feature}</span>
                <span className="font-mono text-[var(--text-muted)]">{f.importance}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function FeasibilitySummary({ verdict }: { verdict: FeasibilityVerdict }) {
  return (
    <div className="card p-3 space-y-1.5">
      <p className="text-xs text-[var(--text-muted)]">{verdict.reason}</p>
      {verdict.supporting_signals.length > 0 && (
        <ul className="text-xs space-y-0.5 pt-1 border-t border-[var(--border)]">
          {verdict.supporting_signals.map((s) => (
            <li key={s.signal_id} className="text-[var(--text-muted)]">
              <span className="font-medium text-[var(--text)]">{s.signal_name}</span>
              {s.asset_name ? (
                <>
                  {" "}measures <span className="font-medium text-[var(--text)]">{s.asset_name}</span>
                </>
              ) : (
                <> (business/event data)</>
              )}{" "}
              — {s.row_count} reading{s.row_count === 1 ? "" : "s"} in{" "}
              <span className="font-mono">{s.source_file}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// One self-contained, permanently-mounted section per objective — each keeps its own
// state independently, so switching attention between objectives never shows one
// objective's stale data underneath another's loading/error state.
function ObjectiveSection({
  projectId,
  slug,
  label,
  hasConfirmedVersion,
  versionCount,
  defaultOpen,
  refreshTick,
}: {
  projectId: string;
  slug: string;
  label: string;
  hasConfirmedVersion: boolean;
  versionCount: number;
  defaultOpen: boolean;
  refreshTick: number;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [verdict, setVerdict] = useState<FeasibilityVerdict | null>(null);
  const [feasibilityError, setFeasibilityError] = useState<string | null>(null);
  const [feasibilityLoading, setFeasibilityLoading] = useState(false);
  const [runs, setRuns] = useState<TrainingRun[]>([]);
  const [selected, setSelected] = useState<TrainingRun | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  useEffect(() => {
    selectedIdRef.current = selected?.id ?? null;
  }, [selected]);

  const refreshRuns = useCallback(async () => {
    const list = await api.listTrainingRuns(projectId, slug);
    setRuns(list);
    const currentId = selectedIdRef.current ?? list[0]?.id;
    setSelected(currentId ? await api.getTrainingRun(projectId, currentId) : null);
  }, [projectId, slug]);

  useEffect(() => {
    if (!hasConfirmedVersion) return;
    // The remaining setStates fire after awaits inside the promise chain —
    // the rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFeasibilityLoading(true);
    setFeasibilityError(null);
    api
      .getFeasibility(projectId, slug)
      .then(setVerdict)
      .catch((e) => setFeasibilityError(e instanceof Error ? e.message : "Could not check feasibility"))
      .finally(() => setFeasibilityLoading(false));
    refreshRuns().catch(() => {});
  }, [projectId, slug, hasConfirmedVersion, versionCount, refreshRuns]);

  // "Train all" in the parent bumps refreshTick after queueing runs — only
  // the runs list re-fetches here, not the (LLM-priced) feasibility check.
  useEffect(() => {
    if (refreshTick === 0 || !hasConfirmedVersion) return;
    // refreshRuns sets state only after its awaits resolve — not synchronously.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refreshRuns().catch(() => {});
  }, [refreshTick, hasConfirmedVersion, refreshRuns]);

  const active = selected && (selected.status === "queued" || selected.status === "running");
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => refreshRuns().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [active, refreshRuns]);

  async function handleStart() {
    setStarting(true);
    setStartError(null);
    try {
      const run = await api.startTraining(projectId, slug);
      setSelected(run);
      await refreshRuns();
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Could not start training");
    } finally {
      setStarting(false);
    }
  }

  const anyActive = runs.some((r) => r.status === "queued" || r.status === "running");
  const feasible = verdict?.attemptable ?? false;

  return (
    <div className="card overflow-hidden">
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-[var(--surface)]"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-xs text-[var(--text-faint)] w-3">{open ? "▾" : "▸"}</span>
          <h2 className="text-sm font-semibold truncate">{label}</h2>
          {hasConfirmedVersion && !feasibilityLoading && verdict && (
            <span className={`badge ${feasible ? "badge-confirmed" : "badge-pending"}`}>
              {feasible ? "attemptable" : "not yet"}
            </span>
          )}
          {feasibilityLoading && <span className="text-xs text-[var(--text-faint)]">checking…</span>}
          {feasibilityError && <span className="text-xs text-[var(--danger)]">{feasibilityError}</span>}
          {selected && <StatusBadge status={selected.status} />}
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)] pt-3">
          {!hasConfirmedVersion ? (
            <p className="text-xs text-[var(--text-faint)]">
              Confirm a graph version first — feasibility and training only ever run against a
              confirmed graph.
            </p>
          ) : (
            <>
              {feasibilityError && (
                <p className="text-xs text-[var(--danger)]">
                  {feasibilityError} — try reloading; this objective&apos;s own check runs
                  independently of the others.
                </p>
              )}
              {verdict && <FeasibilitySummary verdict={verdict} />}

              <div className="flex items-center justify-between">
                <p className="text-xs text-[var(--text-faint)]">
                  {runs.length === 0
                    ? "No training runs yet for this objective."
                    : `${runs.length} run${runs.length === 1 ? "" : "s"} so far.`}
                </p>
                <button
                  className="btn btn-primary text-xs px-3 py-1.5"
                  onClick={handleStart}
                  disabled={starting || Boolean(anyActive) || !feasible}
                  title={!feasible ? "Feasibility says this objective is not attemptable yet" : ""}
                >
                  {starting ? "Starting…" : anyActive ? "In queue…" : "Start training"}
                </button>
              </div>
              {startError && <p className="text-xs text-[var(--danger)]">{startError}</p>}

              {selected && (
                <>
                  <div className="flex items-center gap-3 text-xs text-[var(--text-faint)]">
                    <span>graph v{selected.version_number}</span>
                    <span>{new Date(selected.created_at).toLocaleString()}</span>
                    {selected.finished_at && (
                      <span>finished {new Date(selected.finished_at).toLocaleTimeString()}</span>
                    )}
                  </div>
                  <RunDetail run={selected} />
                </>
              )}

              {runs.length > 1 && (
                <div className="pt-2">
                  <h3 className="text-xs font-semibold mb-1 text-[var(--text-faint)]">Previous runs</h3>
                  <ul className="text-xs space-y-1">
                    {runs.map((r) => (
                      <li key={r.id}>
                        <button
                          className={`w-full flex items-center justify-between px-2 py-1 rounded hover:bg-[var(--surface)] ${
                            r.id === selected?.id ? "bg-[var(--surface)]" : ""
                          }`}
                          onClick={() => api.getTrainingRun(projectId, r.id).then(setSelected)}
                        >
                          <span className="flex items-center gap-2">
                            <StatusBadge status={r.status} />
                            <span>graph v{r.version_number}</span>
                          </span>
                          <span className="text-[var(--text-faint)]">
                            {new Date(r.created_at).toLocaleString()}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function ComputationPanel({
  projectId,
  hasConfirmedVersion,
  versionCount,
}: {
  projectId: string;
  hasConfirmedVersion: boolean;
  versionCount: number;
}) {
  const [trainingAll, setTrainingAll] = useState(false);
  const [trainAllMsg, setTrainAllMsg] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  async function handleTrainAll() {
    setTrainingAll(true);
    setTrainAllMsg(null);
    // Queue every objective at once — the backend accepts them all and runs
    // them in turn; per-objective failures (e.g. already queued) are listed,
    // not hidden.
    const results = await Promise.allSettled(OBJECTIVES.map((o) => api.startTraining(projectId, o.slug)));
    const queued = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .map((r, i) =>
        r.status === "rejected"
          ? `${OBJECTIVES[i].label}: ${r.reason instanceof Error ? r.reason.message : "failed"}`
          : null
      )
      .filter(Boolean);
    setTrainAllMsg(`${queued} of ${OBJECTIVES.length} objectives queued.${errors.length ? ` ${errors.join("; ")}` : ""}`);
    setRefreshTick((t) => t + 1);
    setTrainingAll(false);
  }

  return (
    <div className="p-6 max-w-[1600px] space-y-3 overflow-y-auto h-full scrollbar-thin">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-base font-semibold">Computation</h1>
          <p className="text-xs text-[var(--text-faint)]">
            One dashboard for every objective — feasibility and trained results, side by side.
          </p>
        </div>
        {hasConfirmedVersion && (
          <button
            className="btn btn-primary text-xs px-3 py-1.5 flex-none"
            onClick={handleTrainAll}
            disabled={trainingAll}
          >
            {trainingAll ? "Queueing…" : "Train all 6"}
          </button>
        )}
      </div>
      {trainAllMsg && <p className="text-xs text-[var(--text-muted)]">{trainAllMsg}</p>}
      {OBJECTIVES.map((o) => (
        <ObjectiveSection
          key={o.slug}
          projectId={projectId}
          slug={o.slug}
          label={o.label}
          hasConfirmedVersion={hasConfirmedVersion}
          versionCount={versionCount}
          defaultOpen
          refreshTick={refreshTick}
        />
      ))}
    </div>
  );
}
