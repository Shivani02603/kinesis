"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Project } from "@/lib/api";
import { DecisionDashboard } from "@/components/DecisionDashboard";
import { useAuthGuard } from "@/lib/useAuthGuard";

export default function DashboardPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const { user, loading: authLoading } = useAuthGuard({ projectId });
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    if (!authLoading && user) api.getProject(projectId).then(setProject).catch(() => {});
  }, [authLoading, user, projectId]);

  if (authLoading || !user || !project) return <div className="p-8 text-sm text-[var(--text-faint)]">Loading…</div>;

  return <DecisionDashboard projectId={projectId} projectName={project.name} />;
}
