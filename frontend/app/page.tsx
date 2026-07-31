"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, clearToken, type Project } from "@/lib/api";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { AdminShell, AdminStat, type ShellNavItem } from "@/components/AdminShell";

export default function SuperAdminHome() {
  const router = useRouter();
  const { user, loading } = useAuthGuard({ requiredRole: "super_admin" });
  const [projects, setProjects] = useState<Project[] | null>(null);
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
      setProjects(await api.listProjects());
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
      // The Company Admin takes it from here — they log in and build their own
      // structure, data, and training. Nothing left for the Super Admin to do
      // but come back to watch the activity feed.
      setName("");
      setIndustry("");
      setMachineCapacity("");
      setAdminName("");
      setAdminEmail("");
      setAdminPassword("");
      setShowOnboard(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create company");
    } finally {
      setCreating(false);
    }
  }

  function handleLogout() {
    clearToken();
    router.replace("/login");
  }

  if (loading || !user) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-[var(--text-faint)]">Loading…</div>;
  }

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
    { label: "Client companies", icon: "apartment", active: true, onClick: () => {} },
  ];

  const dotClass: Record<string, string> = {
    "k-dot-ok": "bg-[var(--success)]",
    "k-dot-watch": "bg-[var(--warning)]",
    "k-dot-off": "bg-[var(--text-faint)]",
  };

  return (
    <AdminShell
      scopeName="All client companies"
      nav={nav}
      userEmail={user.email}
      onLogout={handleLogout}
      title="Client companies"
    >
      {error && <div className="bg-white rounded-xl border border-[var(--danger)] p-4 mb-6 text-sm text-[var(--danger)]">{error}</div>}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-6">
        <AdminStat
          label="Client companies"
          value={String(projects?.length ?? "—")}
          sub={projects ? `${liveCount} live · ${onboardingCount} onboarding` : undefined}
        />
        <AdminStat label="Machines under contract" value={String(machinesUnderContract)} sub="across all clients" />
        <AdminStat
          label="Data health"
          value={dataHealthPct === null ? "—" : `${dataHealthPct}%`}
          sub="companies healthy"
          tone={dataHealthPct === null ? undefined : dataHealthPct === 100 ? "ok" : "watch"}
        />
      </div>

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
            <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-5 bg-[var(--surface-2)] rounded-lg p-3">
              <input
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Company name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
                placeholder="Industry"
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

              <div className="col-span-1 sm:col-span-3 text-[11px] font-bold uppercase tracking-wide text-[var(--text-faint)] pt-1 border-t border-[var(--border)] mt-1">
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
                className="btn btn-primary col-span-1 sm:col-span-3"
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
                        <button className="btn btn-outline" onClick={() => router.push(`/companies/${p.id}`)}>
                          Open
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
    </AdminShell>
  );
}
