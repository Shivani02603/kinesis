"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  api,
  type FileEntry,
  type GraphData,
  type GraphVersion,
  type Project,
  type ReviewItem,
} from "@/lib/api";
import { UploadPanel } from "@/components/UploadPanel";
import { ReviewQueue } from "@/components/ReviewQueue";
import { GraphView } from "@/components/GraphView";
import { ComputationPanel } from "@/components/ComputationPanel";

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();

  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [versions, setVersions] = useState<GraphVersion[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<"graph" | "computation">("graph");

  const refresh = useCallback(async () => {
    try {
      const [p, f, g, r, v] = await Promise.all([
        api.getProject(projectId),
        api.listFiles(projectId),
        api.getGraph(projectId),
        api.listReviewItems(projectId, "pending"),
        api.listVersions(projectId),
      ]);
      setProject(p);
      setFiles(f);
      setGraph(g);
      setReviewItems(r);
      setVersions(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load project");
    }
  }, [projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleConfirmVersion() {
    setConfirming(true);
    setError(null);
    try {
      await api.confirmVersion(projectId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm version");
    } finally {
      setConfirming(false);
    }
  }

  if (error) {
    return (
      <div className="p-8 text-sm text-[var(--danger)]">
        {error}
      </div>
    );
  }

  if (!project) {
    return <div className="p-8 text-sm text-[var(--text-faint)]">Loading…</div>;
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <header className="border-b border-[var(--border)] px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <button className="btn btn-ghost" onClick={() => router.push("/")}>
            ← Projects
          </button>
          <div className="min-w-0">
            <h1 className="text-sm font-semibold truncate">{project.name}</h1>
            <p className="text-xs text-[var(--text-faint)]">
              {versions.length > 0
                ? `Confirmed version ${versions[0].version_number} — ${new Date(versions[0].confirmed_at).toLocaleString()}`
                : "Not yet confirmed"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {reviewItems.length > 0 && (
            <span className="badge badge-pending">{reviewItems.length} pending</span>
          )}
          {versions.length > 0 && (
            <button className="btn btn-outline" onClick={() => router.push(`/projects/${projectId}/dashboard`)}>
              Daily dashboard →
            </button>
          )}
          <button
            className="btn btn-primary"
            onClick={handleConfirmVersion}
            disabled={confirming || reviewItems.length > 0 || graph.nodes.length === 0}
            title={reviewItems.length > 0 ? "Resolve all pending review items first" : ""}
          >
            {confirming ? "Confirming…" : "Confirm version"}
          </button>
        </div>
      </header>

      <div className="flex-1 flex min-h-0">
        <aside className="w-96 shrink-0 border-r border-[var(--border)] p-4 space-y-6 overflow-y-auto scrollbar-thin">
          <UploadPanel projectId={projectId} files={files} onChanged={refresh} />

          <div>
            <h2 className="text-sm font-semibold mb-2">Review</h2>
            <ReviewQueue items={reviewItems} projectId={projectId} onChanged={refresh} />
          </div>

          {versions.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold mb-2">Versions</h2>
              <ul className="text-xs space-y-1">
                {versions.map((v) => (
                  <li key={v.id} className="flex items-center justify-between text-[var(--text-muted)]">
                    <span>v{v.version_number}</span>
                    <span>{new Date(v.confirmed_at).toLocaleDateString()}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <main className="flex-1 min-w-0 flex flex-col">
          <div className="flex items-center gap-1 border-b border-[var(--border)] px-4 pt-2 shrink-0">
            {(["graph", "computation"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setMainTab(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
                  mainTab === tab
                    ? "border-[var(--accent,#8b5e3c)] text-[var(--text)]"
                    : "border-transparent text-[var(--text-faint)] hover:text-[var(--text-muted)]"
                }`}
              >
                {tab === "graph" ? "Process graph" : "Computation"}
              </button>
            ))}
          </div>
          <div className="flex-1 min-h-0">
            {mainTab === "graph" ? (
              <GraphView graph={graph} />
            ) : (
              <ComputationPanel
                projectId={projectId}
                hasConfirmedVersion={versions.length > 0}
                versionCount={versions.length}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
