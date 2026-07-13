"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, type Project } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
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
    load();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const project = await api.createProject(name.trim());
      setName("");
      router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create project");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="flex-1 flex justify-center px-6 py-14 overflow-y-auto scrollbar-thin">
      <div className="w-full max-w-2xl">
        <header className="mb-8">
          <h1 className="text-2xl font-semibold tracking-tight">Understanding Engine</h1>
          <p className="text-sm text-[var(--text-muted)] mt-1">
            Upload a client&apos;s factory documents, review what the system found, confirm the graph.
          </p>
        </header>

        <form onSubmit={handleCreate} className="card p-4 flex gap-2 mb-8">
          <input
            className="flex-1 border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-[var(--bg)] focus:outline-none focus:border-[var(--accent)]"
            placeholder="New project name (e.g. Acme Steel Plant)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={creating || !name.trim()}>
            {creating ? "Creating…" : "Create project"}
          </button>
        </form>

        {error && (
          <div className="card p-4 mb-6 border-[var(--danger)] text-sm text-[var(--danger)]">
            {error} — is the backend running on http://localhost:8000?
          </div>
        )}

        <div className="space-y-2">
          {projects === null && !error && (
            <p className="text-sm text-[var(--text-faint)]">Loading…</p>
          )}
          {projects?.length === 0 && (
            <p className="text-sm text-[var(--text-faint)]">No projects yet — create one above.</p>
          )}
          {projects?.map((p) => (
            <button
              key={p.id}
              onClick={() => router.push(`/projects/${p.id}`)}
              className="card p-4 w-full flex items-center justify-between text-left hover:border-[var(--accent)] transition-colors"
            >
              <div>
                <div className="font-medium text-sm">{p.name}</div>
                <div className="text-xs text-[var(--text-faint)] mt-0.5">
                  {new Date(p.created_at).toLocaleString()}
                </div>
              </div>
              {!!p.pending_review_count && (
                <span className="badge badge-pending">{p.pending_review_count} pending</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
