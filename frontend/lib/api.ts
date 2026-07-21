const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// The real session token — a plain bearer token, no cookies/server rendering
// involved anywhere in this app, so localStorage is the one source of truth
// for "am I logged in" on every request.
const TOKEN_KEY = "kinesis_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export type AuthUser = {
  id: string;
  email: string;
  role: "super_admin" | "company_admin" | "operational";
  project_id: string | null;
  name: string | null;
  job_title?: string | null;
  last_active_at?: string | null;
};

export type Project = {
  id: string;
  name: string;
  created_at: string;
  industry?: string | null;
  machine_capacity?: number | null;
  pending_review_count?: number;
  asset_count?: number;
  latest_version?: number | null;
};

export type FileEntry = {
  filename: string;
  processed: boolean;
};

export type DiscoveryLogLine = { tag: string; text: string };

export type DiscoveryProgress = {
  status: "idle" | "queued" | "running" | "succeeded" | "failed";
  step: number;
  phase: string;
  phase_sub: string;
  log: DiscoveryLogLine[];
  entities: number;
  merges: number;
  gaps: number;
  error: string | null;
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
  priority?: string | null;
  priority_weight?: number;
  product?: string | null;
  tasks: ScheduleTask[];
};

export type TrainingResult = {
  task_type: "forecasting" | "supervised" | "scheduling";
  best_model?: string;
  eval_metric?: string;
  leaderboard?: LeaderboardEntry[];
  why_model_won?: string | null;
  // Real component weights of a winning WeightedEnsemble, from AutoGluon itself.
  // Absent/null when the winner isn't an ensemble — never a guessed breakdown.
  ensemble_composition?: { model: string; weight: number }[] | null;
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
  status: "queued" | "running" | "succeeded" | "failed" | "unsupported";
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

// The quote model's input fields are never a fixed list — they come from
// whichever columns the real order data actually has, minus whatever an LLM
// judged isn't knowable before a new order is placed. The frontend renders
// exactly the fields the backend reports, nothing assumed.
export type QuoteModelStatus =
  | { status: "untrained" }
  | { status: "pending"; run_id: string }
  | { status: "failed"; run_id: string; error: string }
  | {
      status: "ready"; run_id: string; feature_columns: string[]; excluded_columns: string[];
      reference_date_column: string | null;
    };

export type QuoteResult = {
  typical_days: number;
  suggested_promise_days: number;
  quantile_levels: number[];
  reference_date?: string;
  typical_date?: string;
  suggested_promise_date?: string;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {};
  if (!(options?.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { headers, ...options });
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
  createProject: (name: string, industry?: string, machineCapacity?: number) =>
    request<Project>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ name, industry: industry ?? null, machine_capacity: machineCapacity ?? null }),
    }),

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
    request<{ processed: string[]; message?: string }>(`/api/projects/${projectId}/run`, { method: "POST" }),
  getDiscoveryProgress: (projectId: string) =>
    request<DiscoveryProgress>(`/api/projects/${projectId}/run/progress`),

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

  getQuoteModelStatus: (projectId: string) =>
    request<QuoteModelStatus>(`/api/projects/${projectId}/objectives/delivery_date/quote-model`),
  trainQuoteModel: (projectId: string) =>
    request<TrainingRun>(`/api/projects/${projectId}/objectives/delivery_date/quote-model/train`, {
      method: "POST",
    }),
  getQuote: (projectId: string, inputs: Record<string, string>) =>
    request<QuoteResult>(`/api/projects/${projectId}/objectives/delivery_date/quote`, {
      method: "POST",
      body: JSON.stringify({ inputs }),
    }),

  login: (email: string, password: string) =>
    request<{ token: string; user: AuthUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
  me: () => request<AuthUser>("/api/auth/me"),

  listProjectUsers: (projectId: string) => request<AuthUser[]>(`/api/projects/${projectId}/users`),
  createProjectUser: (
    projectId: string,
    body: { email: string; password: string; role: "company_admin" | "operational"; name?: string; job_title?: string }
  ) => request<AuthUser>(`/api/projects/${projectId}/users`, { method: "POST", body: JSON.stringify(body) }),

  getDataSource: (projectId: string) => request<DataSourceStatus>(`/api/projects/${projectId}/data-source`),
  setDataSource: (projectId: string, url: string) =>
    request<{ configured: boolean; url: string }>(`/api/projects/${projectId}/data-source`, {
      method: "PUT",
      body: JSON.stringify({ url }),
    }),
  refreshDataSource: (projectId: string) =>
    request<RefreshSummary>(`/api/projects/${projectId}/data-source/refresh`, { method: "POST" }),

  createStructureRequest: (projectId: string, description: string, attachedFiles: string[] = []) =>
    request<StructureRequest>(`/api/projects/${projectId}/structure-requests`, {
      method: "POST",
      body: JSON.stringify({ description, attached_files: attachedFiles }),
    }),
  listProjectStructureRequests: (projectId: string) =>
    request<StructureRequest[]>(`/api/projects/${projectId}/structure-requests`),
  listAllStructureRequests: () => request<StructureRequest[]>("/api/structure-requests"),
  resolveStructureRequest: (requestId: string, status: "approved" | "rejected", note?: string) =>
    request<StructureRequest>(`/api/structure-requests/${requestId}/resolve`, {
      method: "POST",
      body: JSON.stringify({ status, resolution_note: note ?? null }),
    }),
};

export type DataSourceFile = {
  file: string;
  key_col: string;
  signal_cols: string[];
  our_rows: number;
  our_latest: string | null;
  source_latest: string | null;
};

export type DataSourceStatus = {
  configured: boolean;
  url: string | null;
  reachable?: boolean;
  error?: string;
  files: DataSourceFile[];
  source_signals: { signal: string; table: string; degrade: boolean }[];
};

export type RefreshSummary = {
  total_rows_added: number;
  retraining: boolean;
  files: { file: string; rows_added: number; latest_key: string | null }[];
};

export type StructureRequest = {
  id: string;
  project_id: string;
  requested_by: string;
  description: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
  resolved_at: string | null;
  resolution_note: string | null;
  attached_files: string[];
  // Where the approve → auto-pipeline flow got to (Option A):
  pipeline_stage: "running" | "needs_review" | "trained" | "failed" | null;
};

export const OBJECTIVES: { slug: string; label: string }[] = [
  { slug: "maintenance", label: "Machine failure risk" },
  { slug: "quality", label: "Quality / defect rate" },
  { slug: "demand_forecast", label: "Demand forecast" },
  { slug: "delivery_date", label: "Delivery date" },
  { slug: "inventory", label: "Inventory / consumption" },
  { slug: "scheduling", label: "Production schedule" },
];
