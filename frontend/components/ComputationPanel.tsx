"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  api,
  OBJECTIVES,
  type FeasibilityVerdict,
  type TrainingResult,
  type TrainingRun,
} from "@/lib/api";
import { ForecastChart } from "./ForecastChart";

const POLL_MS = 4000;

const OBJECTIVE_ICONS: Record<string, string> = {
  maintenance: "precision_manufacturing",
  quality: "verified",
  demand_forecast: "trending_up",
  delivery_date: "local_shipping",
  inventory: "inventory_2",
  scheduling: "view_timeline",
};

const STATUS_BADGES: Record<TrainingRun["status"], { label: string; cls: string }> = {
  queued: { label: "queued", cls: "badge-pending" },
  running: { label: "training…", cls: "badge-pending" },
  succeeded: { label: "trained", cls: "badge-confirmed" },
  failed: { label: "failed", cls: "badge-rejected" },
  // Not a failure — an honest "the data doesn't support this objective yet".
  unsupported: { label: "not applicable", cls: "badge-neutral" },
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
      <h3 className="text-sm font-semibold">Model leaderboard — live</h3>
      <p className="text-xs text-[var(--text-faint)]">
        Every model AutoGluon tried, scored on held-out validation data. Metric: {result.eval_metric}
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--text-faint)] border-b border-[var(--border)]">
              <th className="py-1.5 pr-4 font-medium">#</th>
              <th className="py-1.5 pr-4 font-medium">Model</th>
              <th className="py-1.5 pr-4 font-medium">Validation score</th>
              <th className="py-1.5 pr-4 font-medium">Fit time (s)</th>
            </tr>
          </thead>
          <tbody>
            {result.leaderboard!.map((m, i) => {
              const isBest = m.model === result.best_model;
              return (
                <tr
                  key={m.model}
                  className={`border-b border-[var(--border)] last:border-0 ${isBest ? "font-semibold" : ""}`}
                  style={isBest ? { background: "var(--success-soft)" } : undefined}
                >
                  <td className="py-1.5 pr-4 font-mono" style={isBest ? { color: "var(--success)" } : undefined}>
                    {i + 1}
                  </td>
                  <td className="py-1.5 pr-4">
                    {m.model}
                    {isBest && <span className="badge badge-confirmed ml-2">best</span>}
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

// AutoGluon's fit() is a single blocking call — it does not stream partial
// leaderboards back to us, so an honestly-live per-model progress bar isn't
// possible; the leaderboard genuinely only exists once fit() returns. What we
// CAN show truthfully is that it's alive and how long it's been going, so the
// screen isn't a frozen "in progress" with no sign of life. The stages listed
// are the real fixed phases AutoGluon moves through, not a fake progress %.
function TrainingInProgress({ run }: { run: TrainingRun }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.floor((Date.now() - new Date(run.created_at).getTime()) / 1000)));
  useEffect(() => {
    const t = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - new Date(run.created_at).getTime()) / 1000)));
    }, 1000);
    return () => clearInterval(t);
  }, [run.created_at]);

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  const queued = run.status === "queued";

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-[var(--accent)] animate-spin text-[20px]">progress_activity</span>
          <div>
            <p className="text-sm font-semibold">{queued ? "Queued — waiting for the trainer" : "Training in progress"}</p>
            <p className="text-xs text-[var(--text-faint)]">
              {queued
                ? "Another objective is training right now; this one starts as soon as it's free."
                : "AutoGluon is fitting and validating several model families on held-out data."}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)]">Elapsed</div>
          <div className="text-lg font-mono font-bold">{mm}:{ss}</div>
        </div>
      </div>
      {!queued && (
        <div className="flex flex-wrap gap-2 pt-2 border-t border-[var(--border)]">
          {["Preparing data", "Fitting model families", "Validating & ranking", "Building final ensemble"].map((phase) => (
            <span key={phase} className="text-[11px] px-2 py-1 rounded bg-[var(--surface-2)] text-[var(--text-muted)]">
              {phase}
            </span>
          ))}
        </div>
      )}
      <p className="text-[11px] text-[var(--text-faint)]">
        The full model leaderboard appears the moment training finishes — AutoGluon reports all candidates together at the
        end, so there is no half-finished ranking to show mid-run. This view refreshes on its own.
      </p>
    </div>
  );
}

// The model writes its reasoning as prose that usually contains an enumerated list —
// sometimes on its own lines ("- x" / "1. x"), often inline inside one paragraph
// ("... available data: 1. foo 2. bar"). Rendered raw it reads as a wall of text, so
// split the list out and show it as real bullets. Purely presentational — the text
// itself is never edited, only where the line breaks fall.
const LIST_MARKER = /^([-*•]|\d+[.)])\s+/;

function parseReasoning(text: string): { intro: string; items: string[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.filter((l) => LIST_MARKER.test(l)).length >= 2) {
    const introLines: string[] = [];
    const items: string[] = [];
    for (const line of lines) {
      if (LIST_MARKER.test(line)) items.push(line.replace(LIST_MARKER, ""));
      else if (items.length === 0) introLines.push(line);
      else items[items.length - 1] += " " + line; // wrapped continuation of the last item
    }
    return { intro: introLines.join(" "), items };
  }

  // Inline enumeration inside a single paragraph. The space before the digit keeps
  // decimals ("0.5") and version numbers from being mistaken for list markers.
  const parts = text.split(/\s(?=\d+[.)]\s)/);
  if (parts.length >= 3) {
    return {
      intro: parts[0].trim(),
      items: parts.slice(1).map((p) => p.replace(/^\d+[.)]\s*/, "").trim()),
    };
  }

  return { intro: text, items: [] };
}

// The raw model reasoning, rendered as clean bullets. Shown inside the collapsed
// "technical detail" section, so it never collapses again on its own.
function ReasoningBullets({ text }: { text: string }) {
  const { intro, items } = parseReasoning(text);
  return (
    <div className="text-xs">
      <p className="text-[var(--text-muted)]">
        <span className="font-medium text-[var(--text)]">Full reasoning: </span>
        {intro}
      </p>
      {items.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {items.map((item, i) => (
            <li key={i} className="flex gap-2 text-[var(--text-muted)]">
              <span className="text-[var(--accent)] font-bold shrink-0">{i + 1}.</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Plain-language name for the approach — what a non-technical reader should see
// first, instead of the bare "forecasting" / "supervised" label.
const APPROACH_HEADLINE: Record<string, string> = {
  forecasting: "Forecasting — watching each signal's own pattern",
  supervised: "Supervised learning — predicting a known outcome",
  scheduling: "Exact scheduling — planning, not prediction",
};

// A readable explanation built ONLY from real facts already in the run (the task
// type, the actual signals modeled, the real label/features) — nothing invented,
// just phrased for a person instead of an engineer.
function plainSummary(result: TrainingResult): string {
  if (result.task_type === "forecasting") {
    const names = (result.series ?? []).map((s) => s.item_id);
    const list =
      names.length === 0
        ? "each monitored signal"
        : names.slice(0, 4).join(", ") + (names.length > 4 ? `, and ${names.length - 4} more` : "");
    return (
      `We track ${list} over time and learn what "normal" looks like for each, then flag any reading that ` +
      `drifts outside its own normal range. There's no record of past outcomes to predict directly, so instead ` +
      `of guessing failures we model each signal's own behaviour and catch the drift early.`
    );
  }
  if (result.task_type === "supervised") {
    const label = (result.params?.label_column as string) || "the outcome";
    const feats = (result.feature_importance ?? []).slice(0, 3).map((f) => f.feature);
    const driver = feats.length ? ` The strongest drivers were ${feats.join(", ")}.` : "";
    return (
      `We learned from past records where ${label} was already known and built a model to predict it for new ` +
      `cases — because that outcome IS recorded in the data, we can learn it directly.${driver}`
    );
  }
  return (
    `Instead of training a model, we solved the plan exactly with a constraint solver — sequencing every order ` +
    `across the machines to hit due dates first and keep the total time short. It's a planning decision, not a prediction.`
  );
}

// Turn the raw params into a few plain sentences a non-technical reader gets;
// anything without a friendly mapping just isn't shown in the plain view (it's
// still in the technical params grid below).
function readableParams(result: TrainingResult): string[] {
  const p = result.params ?? {};
  const out: string[] = [];
  const num = (v: unknown) => (typeof v === "number" ? v : Number(v));
  if (p.prediction_length != null) out.push(`Forecasts ${num(p.prediction_length)} steps ahead.`);
  if (p.shortest_series_length != null) out.push(`Learned from ${num(p.shortest_series_length)} readings of history.`);
  if (p.training_rows != null) out.push(`Learned from ${num(p.training_rows)} completed records.`);
  if (p.time_limit_seconds != null) out.push(`Trained for up to ${Math.round(num(p.time_limit_seconds) / 60)} min.`);
  return out;
}

// When the winner is a WeightedEnsemble, AutoGluon gives us its real component
// weights — showing them explains WHY the ensemble won (it blends the best
// models). Weights are normalised to percentages for reading; the underlying
// numbers are AutoGluon's own, nothing invented. Renders nothing when the winner
// isn't an ensemble (composition is null).
function EnsembleComposition({ composition }: { composition?: { model: string; weight: number }[] | null }) {
  if (!composition || composition.length === 0) return null;
  const total = composition.reduce((s, c) => s + c.weight, 0) || 1;
  return (
    <div className="pt-2 border-t border-[var(--border)]">
      <p className="text-xs font-medium text-[var(--text)] mb-1.5">
        This ensemble blends {composition.length} model{composition.length === 1 ? "" : "s"}:
      </p>
      <div className="space-y-1">
        {composition.map((c) => {
          const pct = Math.round((c.weight / total) * 100);
          return (
            <div key={c.model} className="flex items-center gap-2 text-xs">
              <span className="w-40 truncate text-[var(--text-muted)]">{c.model}</span>
              <div className="flex-1 h-2 bg-white/60 rounded-full overflow-hidden">
                <span className="block h-full rounded-full bg-[var(--success)]" style={{ width: `${pct}%` }} />
              </div>
              <span className="w-9 text-right font-mono text-[var(--text-muted)]">{pct}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function WhyTechnique({ run }: { run: TrainingRun }) {
  const result = run.result;
  const [open, setOpen] = useState(false);
  if (!result) return null;
  const plainParams = readableParams(result);
  const hasTechnical = Boolean(run.decision_reasoning) || Object.keys(result.params ?? {}).length > 0;

  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Why this technique</h3>
        <span className="badge">{result.task_type}</span>
      </div>
      <p className="text-sm font-semibold text-[var(--text)]">
        {APPROACH_HEADLINE[result.task_type] ?? result.task_type}
      </p>
      <p className="text-xs text-[var(--text-muted)]">{plainSummary(result)}</p>
      {plainParams.length > 0 && (
        <ul className="text-xs text-[var(--text-faint)] space-y-0.5 pt-1">
          {plainParams.map((line) => (
            <li key={line} className="flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[14px]">check_small</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {hasTechnical && (
        <div className="pt-1">
          <button
            onClick={() => setOpen((v) => !v)}
            className="text-[var(--accent)] text-xs font-semibold hover:underline"
          >
            {open ? "Hide technical detail" : "Show technical detail"}
          </button>
          {open && (
            <div className="mt-2 space-y-3">
              {run.decision_reasoning && <ReasoningBullets text={run.decision_reasoning} />}
              {Object.keys(result.params ?? {}).length > 0 && (
                <div className="pt-2 border-t border-[var(--border)]">
                  <ParamsGrid params={result.params} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ObjectiveDetail({ run }: { run: TrainingRun }) {
  if (run.status === "unsupported") {
    return (
      <div className="card p-4 space-y-1">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-[var(--text-faint)] text-[18px]">info</span>
          <h3 className="text-sm font-semibold">Not applicable with the current data</h3>
        </div>
        <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{run.error}</p>
        <p className="text-xs text-[var(--text-faint)]">
          This isn&apos;t an error — the system checked and the data doesn&apos;t support this objective yet.
          Add the relevant data and it becomes trainable.
        </p>
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="card p-4 space-y-1" style={{ borderColor: "var(--danger)" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--danger)" }}>Training failed</h3>
        <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{run.error}</p>
        <p className="text-xs text-[var(--text-faint)]">
          Failures are reported verbatim — nothing is retried or masked silently.
        </p>
      </div>
    );
  }

  if (run.status === "queued" || run.status === "running") {
    return <TrainingInProgress run={run} />;
  }

  const result = run.result;
  if (!result) return null;

  return (
    <div className="space-y-4">
      <WhyTechnique run={run} />

      {result.why_model_won && (
        <div className="card p-4 space-y-2" style={{ background: "var(--success-soft)", borderColor: "var(--success)" }}>
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[var(--success)] text-[18px]">emoji_events</span>
            <h3 className="text-sm font-semibold">Winning model: {result.best_model}</h3>
          </div>
          <p className="text-xs text-[var(--text-muted)]">{result.why_model_won}</p>
          <EnsembleComposition composition={result.ensemble_composition} />
        </div>
      )}

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

// One self-contained, permanently-mounted unit per objective — each keeps its own
// state independently, so switching attention between objectives never shows one
// objective's stale data underneath another's loading/error state. It always
// renders its own compact queue row; when it's the active objective, it also
// portals its full detail into the shared right-hand panel.
function ObjectiveSection({
  projectId,
  slug,
  label,
  hasConfirmedVersion,
  versionCount,
  active,
  onSelect,
  detailPanelEl,
  refreshTick,
}: {
  projectId: string;
  slug: string;
  label: string;
  hasConfirmedVersion: boolean;
  versionCount: number;
  active: boolean;
  onSelect: () => void;
  detailPanelEl: HTMLDivElement | null;
  refreshTick: number;
}) {
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

  const runActive = selected && (selected.status === "queued" || selected.status === "running");
  useEffect(() => {
    if (!runActive) return;
    const t = setInterval(() => refreshRuns().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [runActive, refreshRuns]);

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
  const unsupported = selected?.status === "unsupported";
  const state: "queued" | "train" | "done" | "idle" =
    selected?.status === "succeeded" ? "done" : anyActive ? "train" : "idle";
  const pct = state === "done" ? 100 : state === "train" ? (selected?.status === "running" ? 60 : 15) : 0;

  const queueRow = (
    <button
      onClick={onSelect}
      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-left transition-colors ${
        active ? "bg-[var(--accent-soft)]" : "hover:bg-[var(--surface-2)]"
      }`}
    >
      <span
        className={`w-8 h-8 rounded-lg flex items-center justify-center flex-none ${
          state === "done" ? "bg-[var(--success)] text-white" : state === "train" ? "bg-[var(--accent)] text-white" : "bg-[var(--surface-2)] text-[var(--text-muted)]"
        }`}
      >
        <span className="material-symbols-outlined text-[18px]">{OBJECTIVE_ICONS[slug] ?? "science"}</span>
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold truncate">{label}</span>
          {hasConfirmedVersion && !feasibilityLoading && verdict && (
            <span className="mini" style={{
              fontSize: "0.6rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em",
              padding: "0.1rem 0.45rem", borderRadius: 999,
              background: state === "done" ? "var(--success-soft)" : state === "train" ? "var(--accent-soft)" : "var(--surface-2)",
              color: state === "done" ? "var(--success)" : state === "train" ? "var(--accent-hover)" : "var(--text-faint)",
            }}>
              {unsupported ? "N/A" : state === "done" ? "Done" : state === "train" ? (selected?.status === "running" ? "Training" : "Queued") : feasible ? "Ready" : "Not yet"}
            </span>
          )}
        </div>
        <div className="h-[5px] bg-[var(--surface-2)] rounded-full overflow-hidden mt-1">
          <span
            className="block h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: state === "done" ? "var(--success)" : "var(--accent)" }}
          />
        </div>
      </div>
    </button>
  );

  const detail = active && detailPanelEl ? createPortal(
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-bold">{label}</h2>
          <p className="text-xs text-[var(--text-faint)]">
            graph v{selected?.version_number ?? versionCount} {selected?.created_at && `· ${new Date(selected.created_at).toLocaleString()}`}
          </p>
        </div>
        {selected && <StatusBadge status={selected.status} />}
      </div>

      {!hasConfirmedVersion ? (
        <p className="text-xs text-[var(--text-faint)]">
          Confirm a graph version first — feasibility and training only ever run against a confirmed graph.
        </p>
      ) : (
        <>
          {feasibilityError && (
            <p className="text-xs" style={{ color: "var(--danger)" }}>
              {feasibilityError} — try reloading; this objective&apos;s own check runs independently of the others.
            </p>
          )}
          {feasibilityLoading && <p className="text-xs text-[var(--text-faint)]">Checking feasibility…</p>}
          {verdict && !feasible && <FeasibilitySummary verdict={verdict} />}

          <div className="flex items-center justify-between">
            <p className="text-xs text-[var(--text-faint)]">
              {runs.length === 0 ? "No training runs yet for this objective." : `${runs.length} run${runs.length === 1 ? "" : "s"} so far.`}
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
          {startError && <p className="text-xs" style={{ color: "var(--danger)" }}>{startError}</p>}

          {selected && <ObjectiveDetail run={selected} />}

          {runs.length > 1 && (
            <div className="pt-2">
              <h3 className="text-xs font-semibold mb-1 text-[var(--text-faint)]">Previous runs</h3>
              <ul className="text-xs space-y-1">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button
                      className={`w-full flex items-center justify-between px-2 py-1 rounded hover:bg-[var(--surface-2)] ${r.id === selected?.id ? "bg-[var(--surface-2)]" : ""}`}
                      onClick={() => api.getTrainingRun(projectId, r.id).then(setSelected)}
                    >
                      <span className="flex items-center gap-2">
                        <StatusBadge status={r.status} />
                        <span>graph v{r.version_number}</span>
                      </span>
                      <span className="text-[var(--text-faint)]">{new Date(r.created_at).toLocaleString()}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>,
    detailPanelEl
  ) : null;

  return (
    <>
      {queueRow}
      {detail}
    </>
  );
}

// How long AutoGluon may train per objective, as a per-project setting (minutes in
// the UI, stored as seconds). A bound, not a target — small data finishes fast
// regardless; big data needs a bigger budget or it gets cut short. 0 = no limit.
const TIME_LIMIT_KEY = "computation.time_limit_seconds";
const DEFAULT_TIME_LIMIT_MIN = 30;

function TimeBudgetControl({ projectId }: { projectId: string }) {
  const [minutes, setMinutes] = useState<string>(String(DEFAULT_TIME_LIMIT_MIN));
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings(projectId).then((s) => {
      const secs = s[TIME_LIMIT_KEY];
      if (secs != null && secs !== "") setMinutes(String(Math.round(Number(secs) / 60)));
    });
  }, [projectId]);

  async function save() {
    const mins = Number(minutes);
    const seconds = Number.isFinite(mins) && mins > 0 ? Math.round(mins * 60) : 0; // 0 = no limit
    await api.putSetting(projectId, TIME_LIMIT_KEY, String(seconds));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    setOpen(false);
  }

  const label = Number(minutes) > 0 ? `${minutes} min` : "no limit";
  return (
    <div className="relative">
      <button
        className="btn btn-outline text-xs px-3 py-1.5 flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
        title="How long each objective may train"
      >
        <span className="material-symbols-outlined text-[16px]">timer</span>
        Training time: {label}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-10 w-64 bg-white rounded-lg border border-[var(--border)] shadow-[var(--shadow-card)] p-3 space-y-2">
          <p className="text-xs text-[var(--text-muted)]">
            Max minutes AutoGluon may train each objective. Small data finishes early anyway; bigger data needs more or
            it gets cut short.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              className="w-20 border border-[var(--border)] rounded-md px-2 py-1 text-sm bg-[var(--bg)]"
              value={minutes}
              onChange={(e) => setMinutes(e.target.value)}
            />
            <span className="text-xs text-[var(--text-faint)]">minutes (0 = no limit)</span>
          </div>
          <button className="btn btn-primary text-xs px-3 py-1.5 w-full" onClick={save}>
            Save
          </button>
        </div>
      )}
      {saved && <span className="absolute -bottom-4 right-0 text-[10px] text-[var(--success)]">Saved</span>}
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
  const [activeSlug, setActiveSlug] = useState(OBJECTIVES[0].slug);
  const [detailPanelEl, setDetailPanelEl] = useState<HTMLDivElement | null>(null);

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
    <div className="p-6 space-y-4 overflow-y-auto h-full scrollbar-thin">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-base font-semibold">Computation</h1>
        </div>
        <div className="flex items-center gap-2 flex-none">
          {hasConfirmedVersion && <TimeBudgetControl projectId={projectId} />}
          {hasConfirmedVersion && (
            <button className="btn btn-primary text-xs px-3 py-1.5" onClick={handleTrainAll} disabled={trainingAll}>
              {trainingAll ? "Queueing…" : `Train all ${OBJECTIVES.length}`}
            </button>
          )}
        </div>
      </div>
      {trainAllMsg && <p className="text-xs text-[var(--text-muted)]">{trainAllMsg}</p>}

      <div className="grid gap-4" style={{ gridTemplateColumns: "300px 1fr", alignItems: "start" }}>
        <div className="card p-3 space-y-1">
          <div className="px-1 pb-1">
            <h3 className="text-sm font-bold">What&apos;s being built</h3>
          </div>
          {OBJECTIVES.map((o) => (
            <ObjectiveSection
              key={o.slug}
              projectId={projectId}
              slug={o.slug}
              label={o.label}
              hasConfirmedVersion={hasConfirmedVersion}
              versionCount={versionCount}
              active={activeSlug === o.slug}
              onSelect={() => setActiveSlug(o.slug)}
              detailPanelEl={detailPanelEl}
              refreshTick={refreshTick}
            />
          ))}
        </div>

        <div ref={setDetailPanelEl} className="min-w-0" />
      </div>
    </div>
  );
}
