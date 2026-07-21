"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, clearToken, type Project, type StructureRequest } from "@/lib/api";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { AdminShell, AdminStat, type ShellNavItem } from "@/components/AdminShell";

type View = "companies" | "requests";

export default function SuperAdminHome() {
  const router = useRouter();
  const { user, loading } = useAuthGuard({ requiredRole: "super_admin" });
  const [view, setView] = useState<View>("companies");
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [requests, setRequests] = useState<StructureRequest[]>([]);
  const [showOnboard, setShowOnboard] = useState(false);
  const [name, setName] = useState("");
  const [industry, setIndustry] = useState("");
  const [machineCapacity, setMachineCapacity] = useState("");
  const [adminName, setAdminName] = useState("");
  const [adminEmail, setAdminEmail] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const [p, r] = await Promise.all([api.listProjects(), api.listAllStructureRequests()]);
      setProjects(p);
      setRequests(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reach the API");
    }
  }

  useEffect(() => {
    // load() sets state after its own awaits resolve, not synchronously in
    // the effect body — the lint rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!loading && user) load();
  }, [loading, user]);

  // While an approved request's auto-pipeline is running, poll so its stage
  // (discovery → trained / needs-review) updates on screen without a manual refresh.
  const anyRunning = requests.some((r) => r.pipeline_stage === "running");
  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => load(), 3000);
    return () => clearInterval(t);
  }, [anyRunning]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !adminEmail.trim() || !adminPassword) return;
    setCreating(true);
    setError(null);
    try {
      const project = await api.createProject(
        name.trim(),
        industry.trim() || undefined,
        machineCapacity ? Number(machineCapacity) : undefined
      );
      try {
        await api.createProjectUser(project.id, {
          email: adminEmail.trim(),
          password: adminPassword,
          role: "company_admin",
          name: adminName.trim() || undefined,
        });
      } catch (adminErr) {
        setError(
          `Company created, but the admin account failed: ${
            adminErr instanceof Error ? adminErr.message : "unknown error"
          }. Add the admin from the company's People & roles page instead.`
        );
        load();
        return;
      }
      setName("");
      setIndustry("");
      setMachineCapacity("");
      setAdminName("");
      setAdminEmail("");
      setAdminPassword("");
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create company");
    } finally {
      setCreating(false);
    }
  }

  async function handleResolve(id: string, status: "approved" | "rejected") {
    await api.resolveStructureRequest(id, status);
    load();
  }

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[var(--text-faint)]">Loading…</div>;
  }

  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const liveCount = (projects ?? []).filter((p) => p.latest_version).length;
  const onboardingCount = (projects ?? []).length - liveCount;
  const machinesUnderContract = (projects ?? []).reduce((sum, p) => sum + (p.machine_capacity ?? 0), 0);
  const healthyCount = (projects ?? []).filter((p) => p.latest_version && !p.pending_review_count).length;
  const dataHealthPct = projects && projects.length > 0 ? Math.round((healthyCount / projects.length) * 100) : null;

  function companyStatus(p: Project) {
    if (!p.latest_version) return { dot: "k-dot-off" as const, label: "Not yet live" };
    if (p.pending_review_count) return { dot: "k-dot-watch" as const, label: `${p.pending_review_count} pending review` };
    return { dot: "k-dot-ok" as const, label: "Healthy" };
  }

  const nav: ShellNavItem[] = [
    { label: "Client companies", icon: "apartment", active: view === "companies", onClick: () => setView("companies") },
    { label: "Structure requests", icon: "inbox", active: view === "requests", badge: pendingCount || undefined, onClick: () => setView("requests") },
  ];

  const dotClass: Record<string, string> = {
    "k-dot-ok": "bg-[var(--success)]",
    "k-dot-watch": "bg-[var(--warning)]",
    "k-dot-off": "bg-[var(--text-faint)]",
  };

  return (
    <AdminShell
      tierLabel="Tier 1 · Platform"
      scopeName="All client companies"
      nav={nav}
      userEmail={user.email}
      onLogout={handleLogout}
      title={view === "companies" ? "Client companies" : "Structure-change requests"}
      subtitle={
        view === "companies"
          ? "Every company using the Kinesis platform."
          : "Raised by a Company Admin when something changed on the floor."
      }
    >
      {error && <div className="bg-white rounded-xl border border-[var(--danger)] p-4 mb-6 text-sm text-[var(--danger)]">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <AdminStat
          label="Client companies"
          value={String(projects?.length ?? "—")}
          sub={projects ? `${liveCount} live · ${onboardingCount} onboarding` : undefined}
        />
        <AdminStat label="Machines under contract" value={String(machinesUnderContract)} sub="across all clients" />
        <AdminStat
          label="Pending requests"
          value={String(pendingCount)}
          sub="structure changes to review"
          tone={pendingCount ? "watch" : "ok"}
        />
        <AdminStat
          label="Data health"
          value={dataHealthPct === null ? "—" : `${dataHealthPct}%`}
          sub="companies healthy"
          tone={dataHealthPct === null ? undefined : dataHealthPct === 100 ? "ok" : "watch"}
        />
      </div>

      {view === "companies" && (
        <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
          <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
            <div>
              <h3 className="text-sm font-extrabold">Companies on the platform</h3>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                Open a company to enter its admin console, structure &amp; training, and data health.
              </p>
            </div>
            <button className="btn btn-primary" onClick={() => setShowOnboard((s) => !s)}>
              <span className="material-symbols-outlined text-[18px]">add</span>
              Onboard new company
            </button>
          </div>

          {showOnboard && (
            <form onSubmit={handleCreate} className="grid grid-cols-3 gap-2 mb-5 bg-[var(--surface-2)] rounded-lg p-3">
              <input
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Company name (e.g. Acme Steel Plant)"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Industry (e.g. Basic Metals)"
                value={industry}
                onChange={(e) => setIndustry(e.target.value)}
              />
              <input
                type="number"
                min={1}
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Machines under contract"
                value={machineCapacity}
                onChange={(e) => setMachineCapacity(e.target.value)}
              />

              <div className="col-span-3 text-[11px] font-bold uppercase tracking-wide text-[var(--text-faint)] pt-1 border-t border-[var(--border)] mt-1">
                First Company Admin — so they can log in once this is onboarded
              </div>
              <input
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Admin name"
                value={adminName}
                onChange={(e) => setAdminName(e.target.value)}
              />
              <input
                type="email"
                required
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Admin email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
              <input
                type="password"
                required
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Temporary password"
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
              />

              <button
                type="submit"
                className="btn btn-primary col-span-3"
                disabled={creating || !name.trim() || !adminEmail.trim() || !adminPassword}
              >
                {creating ? "Onboarding…" : "Create company & admin, start discovery"}
              </button>
            </form>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase font-bold text-[var(--text-faint)] border-b border-[var(--border)]">
                  <th className="pb-2 pr-4">Company</th>
                  <th className="pb-2 pr-4">Industry</th>
                  <th className="pb-2 pr-4">Plan</th>
                  <th className="pb-2 pr-4">Machines</th>
                  <th className="pb-2 pr-4">Data health</th>
                  <th className="pb-2 pr-4">Graph version</th>
                  <th className="pb-2"></th>
                </tr>
              </thead>
              <tbody>
                {projects?.map((p) => {
                  const status = companyStatus(p);
                  return (
                    <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-3 pr-4 font-semibold">{p.name}</td>
                      <td className="py-3 pr-4 text-[var(--text-muted)]">{p.industry || "—"}</td>
                      <td className="py-3 pr-4">
                        {p.machine_capacity ? (
                          <span className="badge badge-info">{p.machine_capacity}-machine</span>
                        ) : (
                          <span className="badge badge-neutral">Onboarding</span>
                        )}
                      </td>
                      <td className="py-3 pr-4 font-mono">
                        {p.asset_count ?? 0} / {p.machine_capacity ?? "—"}
                      </td>
                      <td className="py-3 pr-4">
                        <span className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${dotClass[status.dot]}`} />
                          {status.label}
                        </span>
                      </td>
                      <td className="py-3 pr-4 font-mono text-[var(--text-faint)]">
                        {p.latest_version ? `v${p.latest_version}` : "draft"}
                      </td>
                      <td className="py-3 text-right">
                        <button className="btn btn-outline" onClick={() => router.push(`/projects/${p.id}`)}>
                          {p.latest_version ? "Open" : "Continue setup"}
                          <span className="material-symbols-outlined text-[16px] ml-1">arrow_forward</span>
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {projects?.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-6 text-center text-[var(--text-faint)]">
                      No companies yet — onboard one above.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {view === "requests" && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
            <h3 className="text-sm font-extrabold mb-3">Pending your review</h3>
            {requests.filter((r) => r.status === "pending").length === 0 && (
              <p className="text-sm text-[var(--text-faint)]">No pending requests.</p>
            )}
            <div className="space-y-3">
              {requests
                .filter((r) => r.status === "pending")
                .map((r) => (
                  <div key={r.id} className="bg-[var(--surface-2)] rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3">
                      <span className="w-10 h-10 rounded-lg bg-[var(--warning-soft)] text-[var(--warning)] flex items-center justify-center flex-none">
                        <span className="material-symbols-outlined text-[20px]">precision_manufacturing</span>
                      </span>
                      <div>
                        <div className="font-semibold text-sm">{r.description}</div>
                        <div className="text-xs text-[var(--text-faint)]">
                          requested by {r.requested_by} · {new Date(r.created_at).toLocaleString()}
                          {r.attached_files.length > 0 && ` · ${r.attached_files.length} file(s) attached`}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <button className="btn btn-outline" onClick={() => handleResolve(r.id, "rejected")}>
                        Reject
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => handleResolve(r.id, "approved")}
                        disabled={r.attached_files.length === 0}
                        title={r.attached_files.length === 0 ? "No data attached — nothing to add" : ""}
                      >
                        Approve &amp; add
                      </button>
                    </div>
                  </div>
                ))}
            </div>
          </div>

          {requests.some((r) => r.status !== "pending") && (
            <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
              <h3 className="text-sm font-extrabold mb-3">Already handled</h3>
              <div className="space-y-2">
                {requests
                  .filter((r) => r.status !== "pending")
                  .map((r) => {
                    const stage = r.pipeline_stage;
                    const badge =
                      r.status === "rejected"
                        ? { cls: "badge-rejected", label: "rejected" }
                        : stage === "running"
                        ? { cls: "badge-pending", label: "discovery running…" }
                        : stage === "needs_review"
                        ? { cls: "badge-pending", label: "needs review" }
                        : stage === "trained"
                        ? { cls: "badge-confirmed", label: "added & retrained" }
                        : stage === "failed"
                        ? { cls: "badge-rejected", label: "failed" }
                        : { cls: "badge-confirmed", label: "approved" };
                    return (
                      <div key={r.id} className="border-b border-[var(--border)] last:border-0 pb-2 last:pb-0">
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-sm font-medium">{r.description}</div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`badge ${badge.cls}`}>{badge.label}</span>
                            {stage === "needs_review" && (
                              <button className="btn btn-outline" onClick={() => router.push(`/projects/${r.project_id}`)}>
                                Review now
                              </button>
                            )}
                          </div>
                        </div>
                        {r.resolution_note && <p className="text-xs text-[var(--text-muted)] mt-1">{r.resolution_note}</p>}
                      </div>
                    );
                  })}
              </div>
            </div>
          )}
        </div>
      )}
    </AdminShell>
  );
}
