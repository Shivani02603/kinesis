"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, clearToken, type ActivityEntry, type Project } from "@/lib/api";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { AdminShell, AdminStat, type ShellNavItem } from "@/components/AdminShell";

// Read-only: the Company Admin now owns their own project end-to-end (uploads,
// discovery, versions, live-sync). This page is the Super Admin's visibility
// into that work — a plain activity list, nothing to approve or act on.
const KIND_ICON: Record<ActivityEntry["kind"], string> = {
  data_processed: "hub",
  version_confirmed: "verified",
  live_sync: "sync",
};

export default function CompanyActivityPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const { user, loading: authLoading } = useAuthGuard({ requiredRole: "super_admin" });

  const [project, setProject] = useState<Project | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, a] = await Promise.all([api.getProject(projectId), api.getActivity(projectId)]);
      setProject(p);
      setActivity(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load company data");
    }
  }, [projectId]);

  useEffect(() => {
    // refresh() sets state after its own awaits resolve, not synchronously in
    // the effect body — the lint rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!authLoading && user) refresh();
  }, [authLoading, user, refresh]);

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (authLoading || !user) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[var(--text-faint)]">Loading…</div>;
  }
  if (error) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[var(--danger)]">{error}</div>;
  }
  if (!project) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[var(--text-faint)]">Loading…</div>;
  }

  const nav: ShellNavItem[] = [
    { label: "Client companies", icon: "apartment", onClick: () => router.push("/") },
  ];

  return (
    <AdminShell
      scopeName={project.name}
      nav={nav}
      userEmail={user.email}
      onLogout={handleLogout}
      title={project.name}
      subtitle="Read-only — the Company Admin manages this company on their own"
    >
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <AdminStat label="Industry" value={project.industry || "—"} />
        <AdminStat label="Machines" value={`${project.asset_count ?? 0} / ${project.machine_capacity ?? "—"}`} sub="under contract" />
        <AdminStat
          label="Confirmed graph"
          value={project.latest_version ? `v${project.latest_version}` : "draft"}
          sub={project.latest_version ? "signed off" : "not yet confirmed"}
        />
        <AdminStat
          label="Open review items"
          value={String(project.pending_review_count ?? 0)}
          sub="the Company Admin's own queue"
          tone={project.pending_review_count ? "watch" : "ok"}
        />
      </div>

      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <h3 className="text-sm font-extrabold mb-1">Activity</h3>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          Everything the Company Admin has done on their own — nothing here needs your action.
        </p>

        {activity.length === 0 ? (
          <p className="text-sm text-[var(--text-faint)]">No activity yet — the Company Admin hasn&apos;t added anything.</p>
        ) : (
          <div className="space-y-3">
            {activity.map((entry) => (
              <div key={entry.id} className="flex items-start gap-3">
                <span className="w-9 h-9 rounded-lg bg-[var(--surface-2)] text-[var(--text-muted)] flex items-center justify-center flex-none">
                  <span className="material-symbols-outlined text-[18px]">{KIND_ICON[entry.kind]}</span>
                </span>
                <div className="min-w-0">
                  <div className="text-sm">{entry.message}</div>
                  <div className="text-xs text-[var(--text-faint)]">{new Date(entry.created_at).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </AdminShell>
  );
}
