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
import { LiveDiscoveryView } from "@/components/LiveDiscoveryView";
import { UploadSourcesPage } from "@/components/UploadSourcesPage";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { TierSidebar, type ShellNavItem } from "@/components/AdminShell";
import { clearToken } from "@/lib/api";

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const { user, loading: authLoading } = useAuthGuard({ requiredRole: "super_admin" });

  const [project, setProject] = useState<Project | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [versions, setVersions] = useState<GraphVersion[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mainTab, setMainTab] = useState<"graph" | "computation">("graph");
  const [showLiveDiscovery, setShowLiveDiscovery] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    // One-time environment check, not a value React itself owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);

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
    if (!authLoading && user) {
      // refresh() and the discovery-progress check both set state after their
      // own awaits resolve, not synchronously in the effect body — the lint
      // rule can't see through the async boundary.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
      // A discovery run kicked off from onboarding (or a previous visit) may
      // still be in flight — detect it once on load so the live view shows
      // immediately instead of the user landing on a plain, stale workbench.
      api.getDiscoveryProgress(projectId).then((p) => {
        if (p.status === "running" || p.status === "queued") setShowLiveDiscovery(true);
      });
    }
  }, [authLoading, user, refresh, projectId]);

  async function handleConfirmVersion() {
    setConfirming(true);
    setError(null);
    try {
      await api.confirmVersion(projectId);
      await refresh();
      // Confirming a version is exactly the moment training becomes possible —
      // jump straight to it so the user doesn't have to hunt for the Computation
      // tab themselves.
      setMainTab("computation");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not confirm version");
    } finally {
      setConfirming(false);
    }
  }

  if (authLoading || !user) {
    return <div className="p-8 text-sm text-[var(--text-faint)]">Loading…</div>;
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

  const nav: ShellNavItem[] = [
    { label: "Client companies", icon: "apartment", onClick: () => router.push("/") },
    { label: "Structure requests", icon: "inbox", onClick: () => router.push("/") },
  ];

  return (
    <div className="h-dvh bg-[var(--bg)] overflow-hidden">
      {sidebarOpen && <div className="fixed inset-0 bg-black/40 z-20 md:hidden" onClick={() => setSidebarOpen(false)} />}
      <TierSidebar
        scopeName={project.name}
        nav={nav}
        userEmail={user.email}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onNavigate={() => {
          if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
        }}
        onLogout={() => {
          clearToken();
          router.replace("/login");
        }}
      />
    <div className={`flex-1 flex flex-col h-dvh transition-[margin] duration-200 ${sidebarOpen ? "md:ml-64" : "md:ml-0"}`}>
      <header className="border-b border-[var(--border)] px-4 md:px-6 py-3 flex items-center justify-between shrink-0 gap-3 flex-wrap">
        <div className="flex items-center gap-3 min-w-0">
          {!sidebarOpen && (
            <button
              onClick={() => setSidebarOpen(true)}
              className="flex-none inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-white text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
              aria-label="Open menu"
            >
              <span className="material-symbols-outlined text-[20px]">menu</span>
            </button>
          )}
          <div className="min-w-0">
          <h1 className="text-sm font-semibold truncate">{project.name} — Structure &amp; Training</h1>
          <p className="text-xs text-[var(--text-faint)]">
            {graph.nodes.length === 0
              ? "Upload sources to build the structure and train the system"
              : versions.length > 0
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
              Operational dashboard →
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

      {showLiveDiscovery ? (
        <div className="flex-1 min-h-0">
          <LiveDiscoveryView
            projectId={projectId}
            onFinished={() => refresh()}
            onContinue={() => setShowLiveDiscovery(false)}
          />
        </div>
      ) : graph.nodes.length === 0 ? (
        // Nothing discovered yet — the only useful action is uploading sources, so give
        // that the whole screen instead of burying it in a narrow side panel next to an
        // empty graph.
        <UploadSourcesPage
          projectId={projectId}
          files={files}
          onChanged={refresh}
          onStarted={() => setShowLiveDiscovery(true)}
        />
      ) : (
        <div className="flex-1 flex flex-col md:flex-row min-h-0">
          {/* Sources/review/versions are about building the structure — none of it applies
              once you're on the training tab, so it isn't shown there at all. */}
          {mainTab === "graph" && (leftCollapsed ? (
            <button
              onClick={() => setLeftCollapsed(false)}
              className="shrink-0 w-full md:w-10 border-b md:border-b-0 md:border-r border-[var(--border)] flex flex-row md:flex-col items-center justify-center md:justify-start gap-2 py-2 md:py-3 hover:bg-[var(--surface-2)] transition-colors"
              title="Show sources & review"
            >
              <span className="material-symbols-outlined text-[20px] text-[var(--text-muted)]">chevron_right</span>
              <span className="material-symbols-outlined text-[18px] text-[var(--text-faint)]">description</span>
              {reviewItems.length > 0 && (
                <span className="text-[10px] font-bold bg-[var(--warning-soft)] text-[var(--warning)] rounded-full w-5 h-5 flex items-center justify-center">
                  {reviewItems.length}
                </span>
              )}
            </button>
          ) : (
            <aside className="w-full md:w-96 shrink-0 max-h-[45vh] md:max-h-none border-b md:border-b-0 md:border-r border-[var(--border)] p-4 overflow-y-auto scrollbar-thin">
              <div className="flex items-center justify-between mb-4">
                <span className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)]">Sources &amp; review</span>
                <button
                  onClick={() => setLeftCollapsed(true)}
                  className="text-[var(--text-faint)] hover:text-[var(--text)] p-1 rounded hover:bg-[var(--surface-2)]"
                  title="Collapse panel"
                >
                  <span className="material-symbols-outlined text-[18px]">chevron_left</span>
                </button>
              </div>
              <div className="space-y-6">
                <UploadPanel
                  projectId={projectId}
                  files={files}
                  onChanged={refresh}
                  onStarted={() => setShowLiveDiscovery(true)}
                />

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
              </div>
            </aside>
          ))}

          <main className="flex-1 min-w-0 min-h-0 flex flex-col">
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
      )}
    </div>
    </div>
  );
}
