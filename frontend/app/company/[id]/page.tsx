"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api, clearToken, type AuthUser, type DataSourceStatus, type GraphData, type Project, type StructureRequest } from "@/lib/api";
import { useAuthGuard } from "@/lib/useAuthGuard";
import { GraphView } from "@/components/GraphView";
import { AdminShell, AdminStat, type ShellNavItem } from "@/components/AdminShell";

type Tab = "overview" | "connections" | "people" | "graph";

export default function CompanyAdminPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const router = useRouter();
  const { user, loading: authLoading } = useAuthGuard({ requiredRole: "company_admin", projectId });

  const [project, setProject] = useState<Project | null>(null);
  const [graph, setGraph] = useState<GraphData>({ nodes: [], edges: [] });
  const [people, setPeople] = useState<AuthUser[]>([]);
  const [requests, setRequests] = useState<StructureRequest[]>([]);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, g, u, r] = await Promise.all([
        api.getProject(projectId),
        api.getGraph(projectId),
        api.listProjectUsers(projectId),
        api.listProjectStructureRequests(projectId),
      ]);
      setProject(p);
      setGraph(g);
      setPeople(u);
      setRequests(r);
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

  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const stageCount = graph.nodes.filter((n) => n.label === "Stage").length;
  const assetCount = graph.nodes.filter((n) => n.label === "Asset").length;
  const signalCount = graph.nodes.filter((n) => n.label === "Signal").length;

  const nav: ShellNavItem[] = [
    { label: "Company console", icon: "space_dashboard", active: tab === "overview", onClick: () => setTab("overview") },
    { label: "Data connections", icon: "cable", active: tab === "connections", onClick: () => setTab("connections") },
    { label: "People & roles", icon: "group", active: tab === "people", onClick: () => setTab("people") },
    { label: "Process map", icon: "account_tree", active: tab === "graph", onClick: () => setTab("graph") },
  ];

  const footer: ShellNavItem[] = [
    { label: "Operational dashboard", icon: "dashboard", onClick: () => router.push(`/projects/${projectId}/dashboard`) },
  ];

  const titles: Record<Tab, { title: string; subtitle: string }> = {
    overview: { title: "Company console", subtitle: `${project.name} · you manage data & people, not structure` },
    connections: { title: "Data connections", subtitle: "Where every signal's routine data comes from." },
    people: { title: "People & roles", subtitle: `${project.name} · who's on the team` },
    graph: { title: "Process map", subtitle: `${project.name} · confirmed factory graph ${project.latest_version ? `v${project.latest_version}` : "(not yet confirmed)"}` },
  };

  return (
    <AdminShell
      tierLabel="Tier 2 · Company"
      scopeName={project.name}
      nav={nav}
      footer={footer}
      userEmail={user.email}
      onLogout={handleLogout}
      title={titles[tab].title}
      subtitle={titles[tab].subtitle}
    >
      {tab === "overview" && (
        <OverviewTab
          project={project}
          people={people}
          requests={requests}
          pendingCount={pendingCount}
          onNavigate={setTab}
          onChanged={refresh}
        />
      )}
      {tab === "connections" && <ConnectionsTab projectId={projectId} />}
      {tab === "people" && <PeopleTab projectId={projectId} people={people} onChanged={refresh} />}
      {tab === "graph" && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            <AdminStat label="Stages" value={String(stageCount)} sub="receiving → dispatch" />
            <AdminStat label="Machines" value={String(assetCount)} sub="assets under contract" />
            <AdminStat label="Signals" value={String(signalCount)} sub="sensors + parameters" />
            <AdminStat label="Relationships" value={String(graph.edges.length)} sub="precedes · part-of · measures" />
          </div>
          <div className="h-[65vh] bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)]">
            <GraphView graph={graph} />
          </div>
        </>
      )}
    </AdminShell>
  );
}

function OverviewTab({
  project,
  people,
  requests,
  pendingCount,
  onNavigate,
  onChanged,
}: {
  project: Project;
  people: AuthUser[];
  requests: StructureRequest[];
  pendingCount: number;
  onNavigate: (t: Tab) => void;
  onChanged: () => void;
}) {
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [description, setDescription] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = requests[0];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!description.trim() || files.length === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      // Upload the new machine's data first so it's sitting in the project, then
      // record its filenames on the request — approving the request is what runs
      // discovery on exactly these files.
      const { saved } = await api.uploadFiles(project.id, files);
      await api.createStructureRequest(project.id, description.trim(), saved);
      setDescription("");
      setFiles([]);
      setShowRequestForm(false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not submit the request");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-[var(--surface-2)] rounded-xl p-4 flex items-center gap-3">
        <span className="material-symbols-outlined text-[var(--accent)] text-[22px]">info</span>
        <p className="text-xs text-[var(--text-muted)] m-0">
          As Company Admin you keep the <b>data flowing</b> and the <b>right people</b> in the right roles. Changing the
          factory&apos;s structure (new machines, re-training the graph) goes to Kinesis as a request — that keeps your
          plan scope and graph accuracy honest.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat label="People" value={String(people.length)} sub="across the team" />
        <AdminStat
          label="Confirmed graph"
          value={project.latest_version ? `v${project.latest_version}` : "draft"}
          sub={project.latest_version ? "signed off" : "not yet confirmed"}
        />
        <AdminStat label="Open requests" value={String(pendingCount)} sub="awaiting Kinesis" tone={pendingCount ? "watch" : "ok"} />
        <AdminStat label="Machines" value={`${project.asset_count ?? 0} / ${project.machine_capacity ?? "—"}`} sub="under contract" />
      </div>

      <div>
        <div className="text-xs uppercase font-bold text-[var(--text-faint)] mb-2 tracking-wide">Manage</div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <button onClick={() => onNavigate("connections")} className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-4 text-left">
            <div className="flex items-center gap-3 mb-2">
              <span className="icon-tile bg-[var(--success-soft)] text-[var(--success)]">
                <span className="material-symbols-outlined">cable</span>
              </span>
              <div>
                <div className="font-bold text-sm">Data connections</div>
                <div className="text-xs text-[var(--text-faint)]">not yet set up</div>
              </div>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-2">Where every signal&apos;s routine data comes from — connected or role-fed.</p>
            <span className="text-xs text-[var(--accent)] font-semibold">Open →</span>
          </button>
          <button onClick={() => onNavigate("people")} className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-4 text-left">
            <div className="flex items-center gap-3 mb-2">
              <span className="icon-tile bg-[var(--info-soft)] text-[var(--info)]">
                <span className="material-symbols-outlined">group</span>
              </span>
              <div>
                <div className="font-bold text-sm">People &amp; roles</div>
                <div className="text-xs text-[var(--text-faint)]">{people.length} people</div>
              </div>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-2">Who sees the operational dashboard and who feeds data through their work.</p>
            <span className="text-xs text-[var(--accent)] font-semibold">Open →</span>
          </button>
          <button onClick={() => onNavigate("graph")} className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-4 text-left">
            <div className="flex items-center gap-3 mb-2">
              <span className="icon-tile bg-[var(--warning-soft)] text-[var(--warning)]">
                <span className="material-symbols-outlined">account_tree</span>
              </span>
              <div>
                <div className="font-bold text-sm">Process map</div>
                <div className="text-xs text-[var(--text-faint)]">{project.asset_count ?? 0} machines</div>
              </div>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-2">Your confirmed factory graph (read-only) — the full picture.</p>
            <span className="text-xs text-[var(--accent)] font-semibold">Open →</span>
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h3 className="text-sm font-extrabold">Need a structure change?</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              New machine, new sensor, or a process step changed — you request, Kinesis reviews &amp; trains it.
            </p>
          </div>
          <button className="btn btn-primary" onClick={() => setShowRequestForm((s) => !s)}>
            <span className="material-symbols-outlined text-[18px]">add</span>
            New request
          </button>
        </div>

        {showRequestForm && (
          <form onSubmit={handleSubmit} className="bg-[var(--surface-2)] rounded-lg p-3 mb-3 space-y-2">
            <textarea
              className="w-full border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
              rows={3}
              placeholder="Describe what changed on the floor (e.g. added Quench Tank QT-2)…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <div>
              <label className="btn btn-outline cursor-pointer text-xs">
                {files.length > 0 ? `${files.length} file(s) attached` : "Attach the new machine's data"}
                <input
                  type="file"
                  multiple
                  accept=".csv,.txt,.pdf"
                  className="hidden"
                  onChange={(e) => setFiles(e.target.files ? Array.from(e.target.files) : [])}
                />
              </label>
              <p className="text-xs text-[var(--text-faint)] mt-1">
                Machine list, sensor tags, routing, SOP — whatever describes the new machine. Kinesis reviews and trains it.
                (CSV, PDF, TXT)
              </p>
            </div>
            {files.length > 0 && (
              <ul className="text-xs text-[var(--text-muted)] space-y-0.5">
                {files.map((f) => (
                  <li key={f.name} className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[14px] text-[var(--text-faint)]">draft</span>
                    {f.name}
                  </li>
                ))}
              </ul>
            )}
            {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
            <button type="submit" className="btn btn-primary" disabled={submitting || !description.trim() || files.length === 0}>
              {submitting ? "Submitting…" : "Submit request"}
            </button>
          </form>
        )}

        {latest ? (
          <div className="bg-[var(--surface-2)] rounded-lg p-4 space-y-1">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">{latest.description}</div>
              <span className={`badge ${latest.status === "approved" ? "badge-confirmed" : latest.status === "rejected" ? "badge-rejected" : "badge-pending"}`}>
                {latest.status === "pending" ? "Pending Kinesis" : latest.status}
              </span>
            </div>
            <div className="text-xs text-[var(--text-faint)]">
              Submitted {new Date(latest.created_at).toLocaleString()}
              {latest.attached_files.length > 0 && ` · ${latest.attached_files.length} file(s)`}
            </div>
            {latest.resolution_note && <p className="text-xs text-[var(--text-muted)]">{latest.resolution_note}</p>}
          </div>
        ) : (
          <p className="text-sm text-[var(--text-faint)]">No requests yet.</p>
        )}
      </div>
    </div>
  );
}

function ConnectionsTab({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<DataSourceStatus | null>(null);
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await api.getDataSource(projectId);
      setStatus(s);
      if (s.url) setUrl(s.url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load data source");
    }
  }, [projectId]);

  useEffect(() => {
    // load() sets state after its awaits — the lint rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.setDataSource(projectId, url.trim());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the URL");
    } finally {
      setSaving(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    setMessage(null);
    setError(null);
    try {
      const r = await api.refreshDataSource(projectId);
      setMessage(
        r.total_rows_added === 0
          ? "Already up to date — no new readings on the source."
          : `Pulled ${r.total_rows_added} new reading(s); ${r.retraining ? "retraining now." : "nothing needed retraining."}`
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-[var(--surface-2)] rounded-xl p-4 flex items-center gap-3">
        <span className="material-symbols-outlined text-[var(--accent)] text-[22px]">cable</span>
        <p className="text-xs text-[var(--text-muted)] m-0">
          Connect the factory&apos;s data source (its sensor database / historian). Kinesis pulls only the new
          readings each time and retrains on them, so predictions keep moving forward without re-uploading anything.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <h3 className="text-sm font-extrabold mb-1">Source connection</h3>
        <p className="text-xs text-[var(--text-muted)] mb-3">
          The data source&apos;s base URL (the factory data simulator, or a real ERP/historian with the same API).
        </p>
        <div className="flex gap-2 flex-wrap">
          <input
            className="flex-1 min-w-[240px] border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-[var(--bg)]"
            placeholder="http://localhost:9000"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button className="btn btn-outline" onClick={handleSave} disabled={saving || !url.trim()}>
            {saving ? "Saving…" : "Save"}
          </button>
          <button className="btn btn-primary" onClick={handleRefresh} disabled={refreshing || !status?.configured}>
            {refreshing ? "Pulling…" : "Refresh predictions"}
          </button>
        </div>
        {status?.configured && status.reachable === false && (
          <p className="text-xs text-[var(--danger)] mt-2">
            Can&apos;t reach the source — is it running? ({status.error})
          </p>
        )}
        {status?.configured && status.reachable && (
          <p className="text-xs text-[var(--success)] mt-2">Connected.</p>
        )}
        {message && <p className="text-xs text-[var(--text-muted)] mt-2">{message}</p>}
        {error && <p className="text-xs text-[var(--danger)] mt-2">{error}</p>}
      </div>

      {status?.configured && status.reachable && status.files.length > 0 && (
        <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
          <h3 className="text-sm font-extrabold mb-3">Connected feeds</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase font-bold text-[var(--text-faint)] border-b border-[var(--border)]">
                  <th className="pb-2 pr-4">Feed</th>
                  <th className="pb-2 pr-4">Signals</th>
                  <th className="pb-2 pr-4">Rows here</th>
                  <th className="pb-2 pr-4">Our latest</th>
                  <th className="pb-2">Source latest</th>
                </tr>
              </thead>
              <tbody>
                {status.files.map((f) => {
                  const behind = f.source_latest && f.our_latest && f.source_latest > f.our_latest;
                  return (
                    <tr key={f.file} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{f.file}</td>
                      <td className="py-2 pr-4 text-[var(--text-muted)]">{f.signal_cols.join(", ")}</td>
                      <td className="py-2 pr-4 font-mono">{f.our_rows}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{f.our_latest ?? "—"}</td>
                      <td className="py-2 font-mono text-xs">
                        {f.source_latest ?? "—"}
                        {behind && <span className="badge badge-pending ml-2">new data</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--text-faint)] mt-3">
            &quot;Refresh predictions&quot; pulls only rows newer than <b>our latest</b> for each feed, dedups them, and
            retrains — so the same reading is never counted twice.
          </p>
        </div>
      )}
    </div>
  );
}

function PeopleTab({ projectId, people, onChanged }: { projectId: string; people: AuthUser[]; onChanged: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"company_admin" | "operational">("operational");
  const [name, setName] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const weekAgo = useMemo(() => new Date().getTime() - 7 * 24 * 60 * 60 * 1000, []);
  const activeCount = people.filter((p) => p.last_active_at && new Date(p.last_active_at).getTime() >= weekAgo).length;

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.createProjectUser(projectId, {
        email: email.trim(),
        password,
        role,
        name: name.trim() || undefined,
        job_title: jobTitle.trim() || undefined,
      });
      setEmail("");
      setPassword("");
      setName("");
      setJobTitle("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create user");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="bg-[var(--surface-2)] rounded-xl p-4 flex items-center gap-3">
        <span className="material-symbols-outlined text-[var(--accent)] text-[22px]">info</span>
        <p className="text-xs text-[var(--text-muted)] m-0">
          Everyone opens the <b>same</b> operational dashboard — a person&apos;s job title just describes what they act
          on.
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat label="People" value={String(people.length)} sub="on the team" />
        <AdminStat label="Active" value={String(activeCount)} sub="signed in this week" tone="ok" />
      </div>

      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <div className="flex items-start justify-between gap-4 mb-4 flex-wrap">
          <div>
            <h3 className="text-sm font-extrabold">Team</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Assign a person&apos;s job — access to the one operational dashboard is the same for all.
            </p>
          </div>
        </div>

        <form onSubmit={handleInvite} className="grid grid-cols-2 lg:grid-cols-5 gap-2 mb-5 bg-[var(--surface-2)] rounded-lg p-3">
          <input
            className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
            placeholder="Job title (e.g. Maintenance)"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
          <input
            type="email"
            required
            className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
            placeholder="Temporary password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            className="border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
            value={role}
            onChange={(e) => setRole(e.target.value as "company_admin" | "operational")}
          >
            <option value="operational">Operational</option>
            <option value="company_admin">Company Admin</option>
          </select>
          {error && <p className="text-xs text-[var(--danger)] col-span-full">{error}</p>}
          <button type="submit" className="btn btn-primary col-span-full lg:col-span-1" disabled={saving || !email.trim() || !password}>
            {saving ? "Inviting…" : "Invite person"}
          </button>
        </form>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase font-bold text-[var(--text-faint)] border-b border-[var(--border)]">
                <th className="pb-2 pr-4">Person</th>
                <th className="pb-2 pr-4">Email</th>
                <th className="pb-2 pr-4">Job</th>
                <th className="pb-2 pr-4">Role</th>
                <th className="pb-2">Active</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-3 pr-4 font-semibold">{p.name ?? "—"}</td>
                  <td className="py-3 pr-4 font-mono text-xs text-[var(--text-faint)]">{p.email}</td>
                  <td className="py-3 pr-4">{p.job_title || "—"}</td>
                  <td className="py-3 pr-4">
                    <span className="badge badge-info">{p.role}</span>
                  </td>
                  <td className="py-3">
                    {p.last_active_at && new Date(p.last_active_at).getTime() >= weekAgo ? (
                      <span className="badge badge-confirmed">Active</span>
                    ) : (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </td>
                </tr>
              ))}
              {people.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-[var(--text-faint)]">
                    No one invited yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
