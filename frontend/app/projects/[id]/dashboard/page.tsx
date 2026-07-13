"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type Project } from "@/lib/api";
import { DecisionDashboard } from "@/components/DecisionDashboard";

export default function DashboardPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    api.getProject(projectId).then(setProject).catch(() => {});
  }, [projectId]);

  if (!project) return <div className="p-8 text-sm text-[var(--text-faint)]">Loading…</div>;

  return <DecisionDashboard projectId={projectId} projectName={project.name} />;
}
