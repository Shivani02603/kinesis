"use client";

import { useEffect, useRef, useState } from "react";
import { api, type DiscoveryProgress, type GraphData } from "@/lib/api";
import { GraphView } from "./GraphView";

const STEPS = ["Parse sources", "Extract entities", "Resolve duplicates", "Build graph", "Validate"];

const TAG_COLOR: Record<string, string> = {
  parse: "text-[var(--info)]",
  extract: "text-[var(--accent)]",
  resolve: "text-[var(--warning)]",
  graph: "text-[var(--success)]",
  validate: "text-[var(--warning)]",
  ok: "text-[var(--success)]",
};

export function LiveDiscoveryView({
  projectId,
  onFinished,
  onContinue,
}: {
  projectId: string;
  onFinished: (progress: DiscoveryProgress) => void;
  onContinue: () => void;
}) {
  const [progress, setProgress] = useState<DiscoveryProgress | null>(null);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    async function tick() {
      try {
        const p = await api.getDiscoveryProgress(projectId);
        if (cancelled) return;
        setProgress(p);
        if (p.status === "running" || p.status === "queued" || p.status === "succeeded") {
          const g = await api.getGraph(projectId);
          if (!cancelled) setGraph(g);
        }
        if ((p.status === "succeeded" || p.status === "failed") && !finishedRef.current) {
          finishedRef.current = true;
          onFinished(p);
        }
      } catch {
        // transient poll failure — next tick tries again
      }
    }

    tick();
    const t = setInterval(() => {
      if (!finishedRef.current) tick();
    }, 700);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  if (!progress) {
    return <div className="p-8 text-sm text-[var(--text-faint)]">Starting…</div>;
  }

  const pct = progress.status === "succeeded" ? 100 : Math.round((progress.step / 4) * 100);
  const reversedLog = [...progress.log].reverse().slice(0, 16);
  const done = progress.status === "succeeded";
  const failed = progress.status === "failed";

  return (
    <div className="p-6 flex flex-col gap-4 h-full max-w-[1800px] mx-auto min-h-0">
      <div className="card p-4 flex-none">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <div
              className="relative w-16 h-16 flex-none rounded-full flex items-center justify-center"
              style={{ background: `conic-gradient(var(--accent) ${pct}%, var(--surface-2) 0)` }}
            >
              <div className="w-[50px] h-[50px] rounded-full bg-white flex items-center justify-center text-sm font-extrabold">
                {pct}%
              </div>
            </div>
            <div>
              <div className="text-xs uppercase font-bold text-[var(--text-faint)]">Now</div>
              <div className="text-lg font-extrabold">{progress.phase}</div>
              <div className="text-xs text-[var(--text-muted)]">{progress.phase_sub}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-[var(--text-faint)] uppercase font-bold">Discovered</div>
            <div className="text-sm">
              <b>{progress.entities}</b> entities · <b>{progress.merges}</b> merges · <b>{progress.gaps}</b> questions
            </div>
          </div>
        </div>

        <div className="flex mt-4">
          {STEPS.map((label, i) => (
            <div key={label} className="flex-1 flex items-center gap-2 px-2 py-2">
              <span
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-extrabold border-[1.5px] flex-none ${
                  i < progress.step
                    ? "bg-[var(--success)] border-[var(--success)] text-white"
                    : i === progress.step && !done
                    ? "bg-[var(--accent)] border-[var(--accent)] text-white"
                    : done
                    ? "bg-[var(--success)] border-[var(--success)] text-white"
                    : "bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-faint)]"
                }`}
              >
                {i + 1}
              </span>
              <span className={`text-xs font-semibold ${i <= progress.step ? "text-[var(--text-muted)]" : "text-[var(--text-faint)]"}`}>
                {label}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 flex-1 min-h-0" style={{ gridTemplateColumns: "380px 1fr" }}>
        <div className="card p-4 flex flex-col min-h-0">
          <div className="flex items-center justify-between mb-2 gap-2 flex-none">
            <div>
              <h3 className="text-sm font-bold">Live activity</h3>
              <p className="text-xs text-[var(--text-faint)]">Every step is shown as it happens — nothing hidden.</p>
            </div>
            {progress.status === "running" && <span className="badge badge-info flex-none">Running</span>}
          </div>
          <div className="font-mono text-xs space-y-1.5 flex-1 min-h-0 overflow-y-auto scrollbar-thin">
            {reversedLog.map((l, i) => (
              <div key={i}>
                <span className={`inline-block w-16 uppercase font-bold text-[10px] ${TAG_COLOR[l.tag] ?? "text-[var(--text-faint)]"}`}>
                  {l.tag}
                </span>
                <span className="text-[var(--text-muted)]">{l.text}</span>
              </div>
            ))}
            {reversedLog.length === 0 && <p className="text-[var(--text-faint)]">Waiting for the first event…</p>}
          </div>
        </div>

        <div className="card flex flex-col min-h-0">
          <div className="p-3 border-b border-[var(--border)] flex-none">
            <h3 className="text-sm font-bold">Process map — assembling</h3>
            <p className="text-xs text-[var(--text-faint)]">Each box appears the moment the system discovers it.</p>
          </div>
          <div className="flex-1 min-h-0">
            <GraphView graph={graph} />
          </div>
        </div>
      </div>

      {done && (
        <div className="card p-4 flex-none" style={{ border: "1px solid var(--success)" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3">
              <span className="icon-tile" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
                <span className="material-symbols-outlined">task_alt</span>
              </span>
              <div>
                <div className="font-extrabold">Discovery complete</div>
                <div className="text-xs text-[var(--text-muted)]">
                  <b>{progress.entities}</b> entities found · <b>{progress.merges}</b> auto-merged ·{" "}
                  <b>{progress.gaps}</b> question{progress.gaps === 1 ? "" : "s"} need your confirmation before this
                  becomes a version.
                </div>
              </div>
            </div>
            <button className="btn btn-primary" onClick={onContinue}>
              {progress.gaps > 0 ? `Review ${progress.gaps} question${progress.gaps === 1 ? "" : "s"}` : "Continue"}
            </button>
          </div>
        </div>
      )}

      {failed && (
        <div className="card p-4 text-sm" style={{ border: "1px solid var(--danger)", color: "var(--danger)" }}>
          <div className="font-semibold mb-1">Discovery failed</div>
          <p className="whitespace-pre-wrap">{progress.error}</p>
          <button className="btn btn-outline mt-3" onClick={onContinue}>
            Back
          </button>
        </div>
      )}
    </div>
  );
}
