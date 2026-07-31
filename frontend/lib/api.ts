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

  getActivity: (projectId: string) => request<ActivityEntry[]>(`/api/projects/${projectId}/activity`),

  listPlanProducts: (projectId: string) => request<PlanProduct[]>(`/api/projects/${projectId}/planning/products`),
  createPlanProduct: (projectId: string, body: PlanProductInput) =>
    request<PlanProduct>(`/api/projects/${projectId}/planning/products`, { method: "POST", body: JSON.stringify(body) }),
  updatePlanProduct: (projectId: string, productId: string, body: PlanProductInput) =>
    request<PlanProduct>(`/api/projects/${projectId}/planning/products/${productId}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlanProduct: (projectId: string, productId: string) =>
    request<{ deleted: boolean }>(`/api/projects/${projectId}/planning/products/${productId}`, { method: "DELETE" }),

  listPlanResources: (projectId: string) => request<PlanResource[]>(`/api/projects/${projectId}/planning/resources`),
  createPlanResource: (projectId: string, body: PlanResourceInput) =>
    request<PlanResource>(`/api/projects/${projectId}/planning/resources`, { method: "POST", body: JSON.stringify(body) }),
  updatePlanResource: (projectId: string, resourceId: string, body: PlanResourceInput) =>
    request<PlanResource>(`/api/projects/${projectId}/planning/resources/${resourceId}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlanResource: (projectId: string, resourceId: string) =>
    request<{ deleted: boolean }>(`/api/projects/${projectId}/planning/resources/${resourceId}`, { method: "DELETE" }),

  getPlanConsumption: (projectId: string) => request<PlanConsumptionCell[]>(`/api/projects/${projectId}/planning/consumption`),
  setPlanConsumption: (projectId: string, cells: PlanConsumptionCell[]) =>
    request<PlanConsumptionCell[]>(`/api/projects/${projectId}/planning/consumption`, {
      method: "PUT", body: JSON.stringify({ cells }),
    }),

  listPlanMachines: (projectId: string) => request<PlanMachine[]>(`/api/projects/${projectId}/planning/machines`),
  createPlanMachine: (projectId: string, body: PlanMachineInput) =>
    request<PlanMachine>(`/api/projects/${projectId}/planning/machines`, { method: "POST", body: JSON.stringify(body) }),
  updatePlanMachine: (projectId: string, machineId: string, body: PlanMachineInput) =>
    request<PlanMachine>(`/api/projects/${projectId}/planning/machines/${machineId}`, { method: "PUT", body: JSON.stringify(body) }),
  deletePlanMachine: (projectId: string, machineId: string) =>
    request<{ deleted: boolean }>(`/api/projects/${projectId}/planning/machines/${machineId}`, { method: "DELETE" }),

  getPlanCompatibility: (projectId: string) =>
    request<PlanCompatibilityCell[]>(`/api/projects/${projectId}/planning/machine-compatibility`),
  setPlanCompatibility: (projectId: string, cells: PlanCompatibilityCell[]) =>
    request<PlanCompatibilityCell[]>(`/api/projects/${projectId}/planning/machine-compatibility`, {
      method: "PUT", body: JSON.stringify({ cells }),
    }),

  getPlanningSettings: (projectId: string) => request<PlanningSettings>(`/api/projects/${projectId}/planning/settings`),
  setPlanningSettings: (projectId: string, body: PlanningSettings) =>
    request<PlanningSettings>(`/api/projects/${projectId}/planning/settings`, { method: "PUT", body: JSON.stringify(body) }),

  solvePlan: (projectId: string) => request<PlanRun>(`/api/projects/${projectId}/planning/solve`, { method: "POST" }),
  listPlanRuns: (projectId: string) => request<PlanRun[]>(`/api/projects/${projectId}/planning/runs`),
  getPlanRun: (projectId: string, runId: string) => request<PlanRun>(`/api/projects/${projectId}/planning/runs/${runId}`),
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

// Read-only history for the Super Admin: what a Company Admin has done on
// their own project — never something to approve or act on.
export type ActivityEntry = {
  id: string;
  project_id: string;
  kind: "data_processed" | "version_confirmed" | "live_sync";
  message: string;
  created_at: string;
};

// ---- Production-mix planning ------------------------------------------

// Price/cost replace a single profit input — profit is always price − cost,
// computed server-side, never a number that could quietly disagree with them.
export type PlanProductInput = {
  name: string; price_per_unit: number; cost_per_unit: number;
  demand_min?: number | null; demand_max?: number | null;
  batch_min?: number | null; batch_max?: number | null;
};
export type PlanProduct = PlanProductInput & { id: string; project_id: string; created_at: string; profit_per_unit: number };

export type PlanResourceInput = { name: string; unit: string; available_capacity: number; kind?: string | null };
export type PlanResource = PlanResourceInput & { id: string; project_id: string; created_at: string };

// Machines are distinct from Resources: a machine has downtime (from the
// maintenance objective) and product-compatibility, neither of which mean
// anything for a pooled resource like material or budget.
export type PlanMachineInput = {
  name: string; available_hours: number; utilization_floor?: number | null; asset_name?: string | null;
};
export type PlanMachine = PlanMachineInput & { id: string; project_id: string; created_at: string };

export type PlanConsumptionCell = { product_id: string; resource_id: string; per_unit: number };
export type PlanCompatibilityCell = { product_id: string; machine_id: string; hours_per_unit: number };

export type PlanningSettings = {
  objective: string;
  demand_ceiling: boolean;
  min_committed_order: boolean;
  pooled_resources: boolean;
  batch_size: boolean;
  utilization_floor: boolean;
};

export const PLANNING_OBJECTIVES: { slug: string; label: string }[] = [
  { slug: "maximize_profit", label: "Maximize profit" },
  { slug: "maximize_revenue", label: "Maximize revenue" },
  { slug: "minimize_cost", label: "Minimize total cost" },
  { slug: "maximize_utilization", label: "Maximize machine utilization" },
  { slug: "maximize_throughput", label: "Maximize throughput (total units)" },
  { slug: "minimize_makespan", label: "Minimize makespan (machine-load proxy)" },
];

export type PlanProductResult = {
  product_id: string; name: string; quantity: number; by_machine: Record<string, number>;
  profit_per_unit: number; profit_contribution: number;
  demand_min: number | null; demand_max: number | null;
  raw_floor: number; production_target: number | null; demand_fulfillment_pct: number | null;
};

export type PlanMachineResult = {
  machine_id: string; name: string; used_hours: number; available_hours: number;
  downtime_hours: number; downtime_tier: "primary" | "fallback" | "none";
  utilization_pct: number; binding: boolean; shadow_price: number;
};

export type PlanResourceResult = {
  resource_id: string; name: string; unit: string;
  used: number; available: number; binding: boolean; shadow_price: number;
};

export type PlanQualityRiskRow = {
  product_id: string; name: string; raw_floor: number; inflated_floor: number; extra_units: number;
};

// Every verdict is its own union member (never combined, e.g. never
// `"empty" | "error"` sharing one member) — TypeScript's control-flow
// narrowing across sequential `if (x.verdict === ...) return` checks does
// NOT reliably exclude one literal out of a combined-literal member.
export type PlanConflict =
  | {
      kind: "capacity"; row_type: "resource" | "machine"; row_id: string; row_name: string; unit: string;
      available: number; minimum_required: number;
      driven_by: { product_id: string; product_name: string; demand_min: number; per_unit: number; contribution: number }[];
    }
  | { kind: "no_compatible_machine"; product_id: string; product_name: string; required: number }
  | { kind: "utilization_floor_unreachable"; machine_id: string; machine_name: string; floor_required_hours: number; max_achievable_hours: number };

export type PlanOutcome =
  | {
      verdict: "solved"; solver_status: string; objective: string; objective_label: string; objective_value: number;
      degenerate_note: string | null;
      products: PlanProductResult[]; machines: PlanMachineResult[]; resources: PlanResourceResult[];
      quality_risk: PlanQualityRiskRow[];
    }
  | { verdict: "infeasible"; message: string; conflicts: PlanConflict[] }
  | { verdict: "missing_inputs"; message: string; products: { product_id: string; product_name: string; missing_field: string }[] }
  | { verdict: "empty"; message: string }
  | { verdict: "error"; message: string };

export type PlanRun = {
  id: string;
  project_id: string;
  status: string;
  error: string | null;
  created_at: string;
  total_profit: number | null;
  objective: string | null;
  objective_value: number | null;
  // Only present on a single-run fetch (getPlanRun/solvePlan) — list_plan_runs
  // omits it, same as training runs, to keep the history list cheap.
  result?: {
    inputs: {
      products: PlanProduct[]; machines: PlanMachineResult[]; resources: PlanResource[];
      compatibility: PlanCompatibilityCell[]; consumption: PlanConsumptionCell[];
      settings: { objective: string; toggles: Record<string, boolean> };
      defect_detail: { worst_signal: string; frac: number; estimated_defect_rate: number } | null;
    };
    output: PlanOutcome;
  };
};

export const OBJECTIVES: { slug: string; label: string }[] = [
  { slug: "maintenance", label: "Machine failure risk" },
  { slug: "quality", label: "Quality / defect rate" },
  { slug: "demand_forecast", label: "Demand forecast" },
  { slug: "delivery_date", label: "Delivery date" },
  { slug: "inventory", label: "Inventory / consumption" },
  { slug: "scheduling", label: "Production schedule" },
];
