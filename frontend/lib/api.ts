const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

export type Project = {
  id: string;
  name: string;
  created_at: string;
  pending_review_count?: number;
};

export type FileEntry = {
  filename: string;
  processed: boolean;
};

export type ReviewItem = {
  id: string;
  project_id: string;
  kind: "ambiguous_merge" | "stage_gap" | "orphan" | "conflict";
  natural_key: string;
  payload: Record<string, string | number>;
  status: "pending" | "confirmed" | "rejected" | "needs_fix";
  created_at: string;
  resolved_at: string | null;
};

export type GraphNode = {
  id: string;
  name: string;
  label: string;
  perspective: string | null;
  confidence: number;
  source_reference: string | null;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: string;
};

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphVersion = {
  id: string;
  project_id: string;
  version_number: number;
  confirmed_at: string;
};

export type SignalDataSummary = {
  signal_id: string;
  signal_name: string;
  asset_name: string | null;
  source_file: string;
  source_column: string;
  row_count: number;
};

export type FeasibilityVerdict = {
  objective: string;
  attemptable: boolean;
  reason: string;
  supporting_signals: SignalDataSummary[];
};

export type LeaderboardEntry = {
  model: string;
  score_val: number | null;
  fit_time: number | null;
  predict_time: number | null;
};

export type ForecastPoint = {
  timestamp: string;
  mean: number;
  q10: number;
  q50: number;
  q90: number;
};

export type HistoryPoint = {
  timestamp: string;
  value: number;
};

export type ForecastSeries = {
  item_id: string;
  history: HistoryPoint[];
  forecast: ForecastPoint[];
};

export type ScheduleTask = {
  machine: string;
  start: string;
  end: string;
  start_h: number;
  end_h: number;
};

export type ScheduleOrder = {
  order_id: string;
  quantity: number;
  due_date: string;
  completion: string;
  hours_late: number;
  on_time: boolean;
  tasks: ScheduleTask[];
};

export type TrainingResult = {
  task_type: "forecasting" | "supervised" | "scheduling";
  best_model?: string;
  eval_metric?: string;
  leaderboard?: LeaderboardEntry[];
  series?: ForecastSeries[];
  feature_importance?: { feature: string; importance: number }[];
  // scheduling payload
  solver_status?: string;
  schedule_start?: string;
  makespan_hours?: number;
  orders_on_time?: number;
  orders_late?: number;
  total_hours_late?: number;
  machines?: string[];
  orders?: ScheduleOrder[];
  params: Record<string, unknown>;
};

export type TrainingRun = {
  id: string;
  project_id: string;
  version_number: number;
  objective: string;
  status: "queued" | "running" | "succeeded" | "failed";
  task_type: string | null;
  decision_reasoning: string | null;
  result?: TrainingResult | null;
  error: string | null;
  model_path: string;
  created_at: string;
  finished_at: string | null;
};

// ---- Decision Layer (D) ------------------------------------------------

export type DashboardCardStatus = "ok" | "watch" | "crit" | "info" | "pending" | "error";

export type DashboardCard = {
  objective: string;
  label: string;
  status: DashboardCardStatus;
  headline: string;
  facts: string[];
  data: Record<string, unknown>;
  actions: string[];
  run_id: string | null;
  checked_at?: string | null;
};

export type DeliveryOrderRow = {
  order_id: string | null;
  quantity?: number;
  destination_region?: string;
  order_date?: string;
  estimated_delivery: string | null;
  promised_date: string | null;
  late_days: number | null;
  [key: string]: unknown;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: options?.body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: res.statusText }));
    // FastAPI's own request-validation errors (422) shape `detail` as a list of
    // {msg, loc, ...} objects, not a string — stringifying that directly gives
    // the unreadable "[object Object]". Extract a real message in every case.
    let message: string;
    if (Array.isArray(body.detail)) {
      message = body.detail
        .map((e: { msg?: string; loc?: unknown[] }) =>
          e.msg ? `${e.msg}${e.loc ? ` (${e.loc.join(".")})` : ""}` : JSON.stringify(e)
        )
        .join("; ");
    } else if (typeof body.detail === "string") {
      message = body.detail;
    } else {
      message = `Request failed: ${res.status}`;
    }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (name: string) =>
    request<Project>("/api/projects", { method: "POST", body: JSON.stringify({ name }) }),

  listFiles: (projectId: string) => request<FileEntry[]>(`/api/projects/${projectId}/files`),
  uploadFiles: async (projectId: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return request<{ saved: string[] }>(`/api/projects/${projectId}/upload`, {
      method: "POST",
      body: form,
    });
  },
  runPipeline: (projectId: string) =>
    request<{ processed: string[]; resolution_log?: string[]; pending_review_count: number; message?: string }>(
      `/api/projects/${projectId}/run`,
      { method: "POST" }
    ),

  getGraph: (projectId: string) => request<GraphData>(`/api/projects/${projectId}/graph`),

  listReviewItems: (projectId: string, status?: string) =>
    request<ReviewItem[]>(`/api/projects/${projectId}/review${status ? `?status=${status}` : ""}`),
  resolveReviewItem: (projectId: string, itemId: string, resolution: string) =>
    request<ReviewItem>(`/api/projects/${projectId}/review/${itemId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ resolution }),
    }),

  confirmVersion: (projectId: string) =>
    request<GraphVersion>(`/api/projects/${projectId}/confirm-version`, { method: "POST" }),
  listVersions: (projectId: string) => request<GraphVersion[]>(`/api/projects/${projectId}/versions`),

  getFeasibility: (projectId: string, objective: string) =>
    request<FeasibilityVerdict>(`/api/projects/${projectId}/feasibility?objective=${encodeURIComponent(objective)}`),

  startTraining: (projectId: string, objective: string) =>
    request<TrainingRun>(`/api/projects/${projectId}/train`, {
      method: "POST",
      body: JSON.stringify({ objective }),
    }),
  listTrainingRuns: (projectId: string, objective: string) =>
    request<TrainingRun[]>(`/api/projects/${projectId}/training-runs?objective=${encodeURIComponent(objective)}`),
  getTrainingRun: (projectId: string, runId: string) =>
    request<TrainingRun>(`/api/projects/${projectId}/training-runs/${runId}`),

  getDashboard: (projectId: string) => request<DashboardCard[]>(`/api/projects/${projectId}/dashboard`),
  getSettings: (projectId: string) => request<Record<string, string>>(`/api/projects/${projectId}/settings`),
  putSetting: (projectId: string, key: string, value: string) =>
    request<Record<string, string>>(`/api/projects/${projectId}/settings`, {
      method: "PUT",
      body: JSON.stringify({ key, value }),
    }),
};

export const OBJECTIVES: { slug: string; label: string }[] = [
  { slug: "maintenance", label: "Machine failure risk" },
  { slug: "quality", label: "Quality / defect rate" },
  { slug: "demand_forecast", label: "Demand forecast" },
  { slug: "delivery_date", label: "Delivery date" },
  { slug: "inventory", label: "Inventory / consumption" },
  { slug: "scheduling", label: "Production schedule" },
];
