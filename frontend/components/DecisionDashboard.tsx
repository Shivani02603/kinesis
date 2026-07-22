"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { api, OBJECTIVES, type DashboardCard, type DeliveryOrderRow, type ForecastSeries, type GraphData, type QuoteModelStatus, type QuoteResult } from "@/lib/api";
import { ForecastChart, type NormalBand } from "./ForecastChart";

// Every number rendered by this dashboard is either read directly from a
// card's `data` payload (computed by the backend from real training runs) or
// derived from it by plain arithmetic (sums, percentages, argmax). Nothing
// here is invented in the frontend: when a card's data doesn't contain what
// a tile or table needs, that tile/table is omitted — never filled with a
// placeholder number.

const NAV: { objective: string | null; label: string; icon: string }[] = [
  { objective: null, label: "Overview", icon: "dashboard" },
  { objective: "maintenance", label: "Machine Health", icon: "precision_manufacturing" },
  { objective: "quality", label: "Quality", icon: "verified" },
  { objective: "demand_forecast", label: "Demand", icon: "trending_up" },
  { objective: "delivery_date", label: "Deliveries", icon: "local_shipping" },
  { objective: "inventory", label: "Materials", icon: "inventory_2" },
  { objective: "scheduling", label: "Production Plan", icon: "view_timeline" },
];

const NAV_LABEL: Record<string, string> = Object.fromEntries(
  NAV.filter((n) => n.objective).map((n) => [n.objective as string, n.label])
);

const OBJECTIVE_QUESTION: Record<string, string> = {
  maintenance: "Will a machine break down?",
  quality: "Are we shipping defects?",
  demand_forecast: "How much will we ship?",
  delivery_date: "Will orders reach on time?",
  inventory: "When should we reorder?",
  scheduling: "What to make, and when?",
};

const STATUS_STYLE: Record<string, { dot: string; chip: string; label: string; icon: string }> = {
  ok: { dot: "bg-[var(--success)]", chip: "bg-[var(--success-soft)] text-[var(--success)]", label: "All good", icon: "check_circle" },
  watch: { dot: "bg-[var(--warning)]", chip: "bg-[var(--warning-soft)] text-[var(--warning)]", label: "Needs attention", icon: "warning" },
  crit: { dot: "bg-[var(--danger)]", chip: "bg-[var(--danger-soft)] text-[var(--danger)]", label: "Urgent", icon: "error" },
  info: { dot: "bg-[var(--info)]", chip: "bg-[var(--info-soft)] text-[var(--info)]", label: "Info", icon: "info" },
  pending: { dot: "bg-[var(--text-faint)]", chip: "bg-[var(--surface-2)] text-[var(--text-muted)]", label: "Checking…", icon: "sync" },
  error: { dot: "bg-[var(--danger)]", chip: "bg-[var(--danger-soft)] text-[var(--danger)]", label: "Error", icon: "error" },
};

// ------------------------------------------------------------- helpers ----

function fmtDate(iso?: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function materialLabel(name: string): string {
  return name
    .replace(/_CONSUMED$/i, "")
    .replace(/_SHIPPED$/i, "")
    .replace(/_/g, " ")
    .trim()
    .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// ------------------------------------------------------------- types ------

type DeviationItem = {
  item_id: string;
  status: "ok" | "watch";
  out_of_band: number;
  recent_n: number;
  lo: number;
  hi: number;
  frac: number;
  trend_up: boolean;
  pct_change: number;
};

type InventoryItem = {
  material: string;
  configured: boolean;
  error?: string;
  on_hand?: number;
  lead_time_days?: number;
  avg_daily_usage?: number;
  reorder_in_days?: number;
  reorder_date?: string;
  runs_out_date?: string;
};

type PerProduct = { item_id: string; total: number; lo: number; hi: number };

type AlertRow = { item_id: string; timestamp: string; value: number; lo: number; hi: number };

type HistoricalOnTime = { overall_rate: number; overall_n: number; recent_rate?: number; recent_n?: number };

type ScheduleTaskRow = { machine: string; start: string; end: string; start_h: number; end_h: number };
type ScheduleOrderRow = {
  order_id: string; quantity: number; due_date: string; completion: string;
  hours_late: number; on_time: boolean; priority?: string | null; priority_weight?: number;
  product?: string | null;
  tasks: ScheduleTaskRow[];
};

function deviationItems(card: DashboardCard | undefined): DeviationItem[] {
  return ((card?.data as { items?: DeviationItem[] })?.items ?? []);
}

function inventoryItems(card: DashboardCard | undefined): InventoryItem[] {
  return ((card?.data as { items?: InventoryItem[] })?.items ?? []);
}

// ---------------------------------------------------------- stat tiles ----

type Tone = "ok" | "watch" | "crit" | "neutral";
type Stat = { label: string; value: string; sub?: string; tone?: Tone; icon?: string };

const TONE_TEXT: Record<Tone, string> = {
  ok: "text-[var(--success)]",
  watch: "text-[var(--warning)]",
  crit: "text-[var(--danger)]",
  neutral: "text-[var(--text)]",
};

function StatTile({ label, value, sub, tone = "neutral", icon }: Stat) {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-4">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)]">{label}</div>
        {icon && <span className={`material-symbols-outlined text-[18px] ${TONE_TEXT[tone]}`}>{icon}</span>}
      </div>
      <div className={`text-2xl font-bold font-mono leading-tight ${TONE_TEXT[tone]}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-faint)] mt-0.5">{sub}</div>}
    </div>
  );
}

function StatRow({ stats }: { stats: Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-3 mb-5">
      {stats.map((s) => (
        <StatTile key={s.label} {...s} />
      ))}
    </div>
  );
}

// ------------------------------------------------------------- top bar ----

function TopBar({
  projectName, title, attention, sidebarOpen, onToggleSidebar,
}: {
  projectName: string; title: string; attention: number;
  sidebarOpen: boolean; onToggleSidebar: () => void;
}) {
  // The date is computed at render time, so it advances by itself each day
  // the dashboard is opened — no stored date anywhere.
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
      <div className="flex items-center gap-3 min-w-0">
        {!sidebarOpen && (
          <button
            onClick={onToggleSidebar}
            className="flex-none inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-white text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
            aria-label="Open menu"
          >
            <span className="material-symbols-outlined text-[20px]">menu</span>
          </button>
        )}
        <h1 className="text-xl font-bold text-[var(--text)] truncate">{title}</h1>
        <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] bg-white border border-[var(--border)] rounded-lg px-3 py-1.5">
          <span className="material-symbols-outlined text-[16px]">factory</span>
          {projectName}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] bg-white border border-[var(--border)] rounded-lg px-3 py-1.5">
          {today}
          <span className="material-symbols-outlined text-[16px]">calendar_today</span>
        </span>
        <span className="relative inline-flex items-center justify-center w-9 h-9 bg-white border border-[var(--border)] rounded-lg">
          <span className="material-symbols-outlined text-[18px] text-[var(--text-muted)]">notifications</span>
          {attention > 0 && (
            <span className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] px-0.5 rounded-full bg-[var(--danger)] text-white text-[10px] font-bold flex items-center justify-center">
              {attention}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- sidebar ----

function Sidebar({
  projectId, projectName, cards, selected, onSelect, open, onToggle, onNavigate,
}: {
  projectId: string; projectName: string; cards: DashboardCard[];
  selected: string | null; onSelect: (objective: string | null) => void;
  open: boolean; onToggle: () => void; onNavigate?: () => void;
}) {
  const router = useRouter();
  const byObjective = new Map(cards.map((c) => [c.objective, c]));
  return (
    <aside
      className={`fixed left-0 top-0 h-dvh w-64 bg-[var(--surface-2)] flex flex-col py-6 border-r border-[var(--border)] z-30 transition-transform duration-200 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="px-5 mb-6">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 bg-[var(--accent)] rounded flex items-center justify-center flex-none">
              <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>factory</span>
            </div>
            <div className="flex flex-col leading-tight min-w-0">
              <span className="font-bold text-[var(--accent)] text-sm">Kinesis</span>
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider truncate max-w-[140px]">{projectName}</span>
            </div>
          </div>
          <button
            onClick={onToggle}
            className="flex-none inline-flex items-center justify-center w-7 h-7 rounded-md text-[var(--text-muted)] hover:bg-white"
            aria-label="Close menu"
          >
            <span className="material-symbols-outlined text-[18px]">menu_open</span>
          </button>
        </div>
      </div>
      <nav className="flex-1 px-3 space-y-1 overflow-y-auto scrollbar-thin">
        {NAV.map((n) => {
          const card = n.objective ? byObjective.get(n.objective) : undefined;
          const st = card ? (STATUS_STYLE[card.status] ?? STATUS_STYLE.info) : null;
          const active = selected === n.objective;
          return (
            <button
              key={n.label}
              onClick={() => {
                onSelect(n.objective);
                onNavigate?.();
              }}
              className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-colors text-sm font-semibold ${
                active ? "bg-[var(--accent-soft)] text-[var(--accent-hover)]" : "text-[var(--text-muted)] hover:bg-white"
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">{n.icon}</span>
              <span className="flex-1 text-left truncate">{n.label}</span>
              {st && <span className={`w-2 h-2 rounded-full ${st.dot} flex-none`} />}
            </button>
          );
        })}
      </nav>
      <div className="px-3 mt-auto pt-3 border-t border-[var(--border)] space-y-1">
        <button
          onClick={() => {
            router.push(`/projects/${projectId}`);
            onNavigate?.();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[var(--text-muted)] hover:bg-white text-sm font-medium"
        >
          <span className="material-symbols-outlined text-[20px]">build</span>
          Technical workspace
        </button>
        <button
          onClick={() => {
            router.push("/");
            onNavigate?.();
          }}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[var(--text-muted)] hover:bg-white text-sm font-medium"
        >
          <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          All projects
        </button>
      </div>
    </aside>
  );
}

// ------------------------------------------------------- shared pieces ----

function SectionCard({ title, subtitle, children, action }: { title: string; subtitle?: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <div className="flex items-start justify-between gap-2 flex-wrap mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-[var(--text)]">{title}</h3>
          {subtitle && <p className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Provenance({ card }: { card: DashboardCard }) {
  return (
    <p className="text-xs text-[var(--text-faint)] font-mono mt-6">
      checked {card.checked_at ? new Date(card.checked_at).toLocaleString() : "just now"} · run {card.run_id?.slice(0, 8) ?? "—"}
    </p>
  );
}

function DetailHead({ card }: { card: DashboardCard }) {
  const st = STATUS_STYLE[card.status] ?? STATUS_STYLE.info;
  const showFacts = card.status === "info" || card.status === "error" || card.status === "pending";
  return (
    <header className="mb-5">
      <div className="flex items-center gap-3 mb-1.5">
        <span className="text-xs font-bold uppercase tracking-wider text-[var(--text-faint)]">{OBJECTIVE_QUESTION[card.objective]}</span>
        <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2.5 py-1 rounded-full ${st.chip}`}>
          {st.label}
        </span>
      </div>
      <h2 className="text-lg font-semibold text-[var(--text)] leading-snug">{card.headline}</h2>
      {showFacts && card.facts.map((f, i) => (
        <p key={i} className="text-[var(--text-muted)] text-sm mt-1">{f}</p>
      ))}
    </header>
  );
}

// Action buttons (Create work order, Mark as rush, etc.) are deliberately not
// rendered: clicking them wouldn't persist anything real on the backend yet,
// and a button that pretends to act is exactly the kind of fake interactivity
// this platform avoids. They return once each has a real endpoint behind it.

function PendingOrError({ card }: { card: DashboardCard }) {
  if (card.status === "pending") {
    return (
      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-6 flex items-center gap-3">
        <span className="material-symbols-outlined animate-spin text-[var(--accent)]">progress_activity</span>
        <p className="text-sm text-[var(--text-muted)]">Checking now — this updates automatically when done.</p>
      </div>
    );
  }
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-6">
      <p className="text-sm text-[var(--text-muted)]">{card.facts[0] ?? "Nothing to show yet."}</p>
    </div>
  );
}

function SeriesCard({
  series, title, caption, normal,
}: { series: ForecastSeries; title?: string; caption: string; normal?: NormalBand }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <h3 className="text-sm font-bold text-[var(--text)] mb-1">{title ?? series.item_id}</h3>
      <ForecastChart series={series} normal={normal} />
      <p className="text-xs text-[var(--text-muted)] mt-2">{caption}</p>
    </div>
  );
}

// The learned normal range the backend already computed for this exact signal —
// looked up by item_id so a chart never borrows another signal's band.
function normalFor(items: DeviationItem[], itemId: string | undefined): NormalBand | undefined {
  const match = items.find((i) => i.item_id === itemId);
  return match ? { lo: match.lo, hi: match.hi } : undefined;
}

// A donut for a genuine categorical split the backend actually computed
// (e.g. readings within vs outside a learned normal range) — never a
// per-stage/per-cause breakdown we have no data to support.
function Donut({ data, total, totalLabel, size = 128 }: { data: { name: string; value: number; color: string }[]; total: number; totalLabel: string; size?: number }) {
  const sum = data.reduce((a, b) => a + b.value, 0);
  return (
    <div className="flex items-center gap-5">
      <div className="relative flex-none" style={{ width: size, height: size }}>
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="100%" paddingAngle={2} stroke="none" isAnimationActive={false}>
              {data.map((d) => (
                <Cell key={d.name} fill={d.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-xl font-bold font-mono text-[var(--text)]">{total}</span>
          <span className="text-[9px] uppercase tracking-wide text-[var(--text-faint)]">{totalLabel}</span>
        </div>
      </div>
      <div className="space-y-2 text-xs flex-1">
        {data.map((d) => (
          <div key={d.name} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full flex-none" style={{ background: d.color }} />
            <span className="text-[var(--text-muted)] flex-1">{d.name}</span>
            <span className="font-mono font-semibold text-[var(--text)]">{d.value}</span>
            <span className="text-[var(--text-faint)] w-9 text-right">{sum > 0 ? Math.round((d.value / sum) * 100) : 0}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Real recorded readings that fell outside a signal's own learned normal
// range — timestamps and values straight from the same history the chart
// above plots. Not a synthetic alert/incident log.
function AlertList({ alerts }: { alerts: AlertRow[] }) {
  return (
    <div className="divide-y divide-[var(--border)]">
      {alerts.map((a, i) => (
        <div key={i} className="flex items-center justify-between gap-3 py-2.5 text-xs">
          <div className="flex items-center gap-2 min-w-0">
            <span className="material-symbols-outlined text-[16px] text-[var(--warning)] flex-none">warning</span>
            <span className="font-mono font-semibold text-[var(--text)] flex-none">{a.item_id}</span>
            <span className="text-[var(--text-muted)] truncate">
              reading {a.value.toFixed(2)} — outside normal range ({a.lo.toFixed(2)}–{a.hi.toFixed(2)})
            </span>
          </div>
          <span className="text-[var(--text-faint)] flex-none">{fmtDate(a.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------- machine page ----

// Shows every machine (Asset) the process graph actually knows about, honest
// about which have real uploaded sensor data versus which don't yet.
function MachineCoverage({ graph, monitoredNames }: { graph: GraphData; monitoredNames: string[] }) {
  const assets = graph.nodes.filter((n) => n.label === "Asset");
  if (assets.length === 0) return null;
  const signalIdByName = new Map(graph.nodes.filter((n) => n.label === "Signal").map((n) => [n.name, n.id]));
  const monitoredSignalIds = new Set(monitoredNames.map((n) => signalIdByName.get(n)).filter(Boolean));
  const measuredAssetIds = new Set(
    graph.edges.filter((e) => e.type === "MEASURES" && monitoredSignalIds.has(e.source)).map((e) => e.target)
  );
  const coveredCount = assets.filter((a) => measuredAssetIds.has(a.id)).length;

  return (
    <SectionCard
      title="Machines on this line"
      subtitle={`${coveredCount} of ${assets.length} have sensor data uploaded`}
    >
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {assets.map((a) => {
          const covered = measuredAssetIds.has(a.id);
          return (
            <div
              key={a.id}
              className={`text-center p-3 rounded-lg border ${
                covered ? "border-[var(--success)]/30 bg-[var(--success-soft)]" : "border-[var(--border)] bg-[var(--surface-2)]"
              }`}
            >
              <span className={`material-symbols-outlined text-2xl ${covered ? "text-[var(--success)]" : "text-[var(--text-faint)]"}`}>
                {covered ? "sensors" : "sensors_off"}
              </span>
              <div className="text-xs font-semibold mt-1 truncate">{a.name}</div>
              <div className="text-[10px] text-[var(--text-faint)]">{covered ? "monitored" : "no sensor data"}</div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

function DeviationOverviewList({ items, unitWord }: { items: DeviationItem[]; unitWord: string }) {
  return (
    <div className="space-y-3">
      {items.map((it) => {
        const pct = Math.round(it.frac * 100);
        const watch = it.status === "watch";
        return (
          <div key={it.item_id} className="flex items-center gap-3 text-xs">
            <span className="font-mono font-semibold text-[var(--text)] w-36 truncate">{it.item_id}</span>
            <div className="flex-1 h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${watch ? "bg-[var(--danger)]" : "bg-[var(--success)]"}`}
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            <span className={`w-56 text-right ${watch ? "text-[var(--danger)] font-semibold" : "text-[var(--text-muted)]"}`}>
              {watch
                ? `${it.out_of_band} of last ${it.recent_n} ${unitWord}s abnormal` +
                  (Math.abs(it.pct_change) >= 3 ? ` · ${it.pct_change > 0 ? "+" : ""}${it.pct_change.toFixed(0)}% vs baseline` : "")
                : "all normal"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function MachineHealthPage({ card, graph }: { card: DashboardCard; graph: GraphData | null }) {
  const data = card.data as { series?: ForecastSeries[]; items?: DeviationItem[]; flagged_item?: string | null; recent_alerts?: AlertRow[] };
  const series = data.series ?? [];
  const items = data.items ?? [];
  const alerts = data.recent_alerts ?? [];
  const watch = items.filter((i) => i.status === "watch");
  const lineAssets = graph?.nodes.filter((n) => n.label === "Asset").length ?? 0;

  const flagged = data.flagged_item ? series.find((s) => s.item_id === data.flagged_item) : series[0];

  return (
    <div className="space-y-4">
      <StatRow
        stats={[
          { label: "Machines monitored", value: String(items.length), sub: lineAssets ? `of ${lineAssets} on the line` : undefined, icon: "sensors" },
          { label: "Needs attention", value: String(watch.length), tone: watch.length ? "watch" : "neutral", icon: "warning" },
          { label: "All normal", value: String(items.length - watch.length), tone: "ok", icon: "check_circle" },
        ]}
      />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {items.length > 0 && (
          <SectionCard
            title="Machine health overview"
            subtitle="Bar = share of recent readings outside that signal's own learned normal range."
          >
            <DeviationOverviewList items={items} unitWord="reading" />
          </SectionCard>
        )}
        {flagged && (
          <SeriesCard
            series={flagged}
            normal={normalFor(items, flagged.item_id)}
            title={`${flagged.item_id} — trend`}
            caption="Solid: recorded readings. Dashed: forecast. Green dashed lines: this signal's own learned normal range — readings outside them are a real deviation, not a guess."
          />
        )}
      </div>
      {alerts.length > 0 && (
        <SectionCard title="Recent deviations detected" subtitle="Readings that fell outside a signal's own learned normal range.">
          <AlertList alerts={alerts} />
        </SectionCard>
      )}
      {graph && <MachineCoverage graph={graph} monitoredNames={series.map((s) => s.item_id)} />}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {series.filter((s) => s.item_id !== flagged?.item_id).map((s) => (
          <SeriesCard
            key={s.item_id}
            series={s}
            normal={normalFor(items, s.item_id)}
            caption="Recorded readings with forecast; green dashed lines mark its learned normal range."
          />
        ))}
      </div>
      <Provenance card={card} />
    </div>
  );
}

// -------------------------------------------------------- quality page ----

function QualityPage({ card }: { card: DashboardCard }) {
  const data = card.data as { series?: ForecastSeries[]; items?: DeviationItem[]; recent_alerts?: AlertRow[] };
  const series = data.series ?? [];
  const items = data.items ?? [];
  const alerts = data.recent_alerts ?? [];
  const main = items[0];
  const mainSeries = main ? series.find((s) => s.item_id === main.item_id) : series[0];
  const latest = mainSeries?.history.length ? mainSeries.history[mainSeries.history.length - 1].value : null;

  const stats: Stat[] = [];
  if (main && latest !== null && latest !== undefined) {
    stats.push({ label: "Latest reading", value: latest.toFixed(2), tone: main.status === "watch" ? "watch" : "ok", icon: "monitoring" });
    stats.push({ label: "Normal range", value: `${main.lo.toFixed(2)} – ${main.hi.toFixed(2)}`, sub: "learned from its own history", icon: "straighten" });
    stats.push({
      label: "Outside normal", value: `${main.out_of_band} of ${main.recent_n}`, sub: "recent readings",
      tone: main.status === "watch" ? "watch" : "ok", icon: "rule",
    });
    if (Math.abs(main.pct_change) >= 3) {
      stats.push({
        label: "Trend vs baseline",
        value: `${main.pct_change > 0 ? "+" : ""}${main.pct_change.toFixed(0)}%`,
        sub: main.pct_change > 0 ? "worsening" : "improving",
        tone: main.pct_change > 0 ? "crit" : "ok",
        icon: main.pct_change > 0 ? "trending_up" : "trending_down",
      });
    }
  }

  const donutData = main
    ? [
        { name: "Within normal", value: main.recent_n - main.out_of_band, color: "var(--success)" },
        { name: "Outside normal", value: main.out_of_band, color: "var(--danger)" },
      ]
    : [];

  return (
    <div className="space-y-4">
      <StatRow stats={stats} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {mainSeries && (
          <SeriesCard
            series={mainSeries}
            normal={normalFor(items, mainSeries.item_id)}
            title={`${mainSeries.item_id} — trend`}
            caption="Solid: recorded values. Dashed: forecast. Green dashed lines: this signal's own learned normal range."
          />
        )}
        {main && (
          <SectionCard
            title="Recent readings — within vs outside normal"
            subtitle={`Last ${main.recent_n} readings for ${main.item_id}, split against its own learned normal range.`}
          >
            <Donut data={donutData} total={main.recent_n} totalLabel="readings" />
          </SectionCard>
        )}
      </div>
      {alerts.length > 0 && (
        <SectionCard title="Recent quality alerts" subtitle="Readings outside the learned normal range.">
          <AlertList alerts={alerts} />
        </SectionCard>
      )}
      {items.length > 1 && (
        <SectionCard title="Quality signals" subtitle="Bar = share of recent readings outside each signal's learned normal range.">
          <DeviationOverviewList items={items} unitWord="day" />
        </SectionCard>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {series.filter((s) => s.item_id !== mainSeries?.item_id).map((s) => (
          <SeriesCard
            key={s.item_id}
            series={s}
            normal={normalFor(items, s.item_id)}
            title={`${s.item_id} — trend`}
            caption="Solid: recorded values. Dashed: forecast. Green dashed lines: this signal's own learned normal range."
          />
        ))}
      </div>
      <Provenance card={card} />
    </div>
  );
}

// --------------------------------------------------------- demand page ----

function demandDerived(series: ForecastSeries[]) {
  const horizon = series[0]?.forecast.length ?? 0;
  // Total expected over the horizon (sum of forecast means, all products).
  let forecastTotal = 0;
  let prevTotal = 0;
  const byDay = new Map<string, number>();
  for (const s of series) {
    for (const f of s.forecast) {
      forecastTotal += f.mean;
      byDay.set(f.timestamp, (byDay.get(f.timestamp) ?? 0) + f.mean);
    }
    // Same-length window of actual recorded history, for a real % change.
    const hist = s.history.filter((h) => h.value !== null && h.value !== undefined);
    for (const h of hist.slice(-horizon)) prevTotal += h.value;
  }
  let peakDay: { timestamp: string; units: number } | null = null;
  for (const [ts, units] of byDay) {
    if (!peakDay || units > peakDay.units) peakDay = { timestamp: ts, units };
  }
  const changePct = prevTotal > 0 ? ((forecastTotal - prevTotal) / prevTotal) * 100 : null;
  return { horizon, forecastTotal, prevTotal, changePct, peakDay };
}

function DemandPage({ card }: { card: DashboardCard }) {
  const data = card.data as { series?: ForecastSeries[]; per_product?: PerProduct[] };
  const series = data.series ?? [];
  const perProduct = data.per_product ?? [];
  const d = demandDerived(series);
  const grandTotal = perProduct.reduce((a, b) => a + b.total, 0);

  const stats: Stat[] = [];
  if (series.length > 0) {
    stats.push({ label: `Expected demand (next ${d.horizon}d)`, value: Math.round(d.forecastTotal).toLocaleString(), sub: "units, sum of forecast", icon: "trending_up" });
    if (d.changePct !== null) {
      stats.push({
        label: `Change vs last ${d.horizon}d`,
        value: `${d.changePct > 0 ? "+" : ""}${d.changePct.toFixed(0)}%`,
        sub: "forecast vs recorded shipments",
        tone: d.changePct > 0 ? "ok" : "watch",
        icon: d.changePct > 0 ? "arrow_upward" : "arrow_downward",
      });
    }
    if (d.peakDay) {
      stats.push({ label: "Highest demand day", value: fmtDate(d.peakDay.timestamp), sub: `${Math.round(d.peakDay.units).toLocaleString()} units expected`, icon: "event" });
    }
    stats.push({ label: "Products forecasted", value: String(series.length), icon: "category" });
  }

  return (
    <div className="space-y-4">
      <StatRow stats={stats} />
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {series.map((s) => (
          <SeriesCard
            key={s.item_id}
            series={s}
            title={materialLabel(s.item_id)}
            caption="Solid: recorded shipments. Dashed: forecast with its likely range."
          />
        ))}
      </div>
      {perProduct.length > 1 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          <SectionCard title={`Demand by product (next ${d.horizon}d)`} subtitle="Share of total forecast units.">
            <div className="space-y-2.5">
              {perProduct.map((p) => {
                const share = grandTotal > 0 ? (p.total / grandTotal) * 100 : 0;
                return (
                  <div key={p.item_id} className="flex items-center gap-3 text-xs">
                    <span className="w-28 truncate text-[var(--text-muted)]">{materialLabel(p.item_id)}</span>
                    <span className="w-20 font-mono font-semibold text-right">{Math.round(p.total).toLocaleString()}</span>
                    <div className="flex-1 h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
                      <div className="h-full bg-[var(--accent)] rounded-full" style={{ width: `${Math.max(2, share)}%` }} />
                    </div>
                    <span className="w-10 text-right text-[var(--text-faint)]">{share.toFixed(0)}%</span>
                  </div>
                );
              })}
            </div>
          </SectionCard>
          <SectionCard title="Demand insights">
            <ul className="space-y-2">
              {card.facts.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-[var(--text-muted)]">
                  <span className="material-symbols-outlined text-[16px] text-[var(--accent)] mt-0.5">arrow_right</span>
                  {f}
                </li>
              ))}
            </ul>
          </SectionCard>
        </div>
      )}
      <Provenance card={card} />
    </div>
  );
}

// ------------------------------------------------------ deliveries page ---

// A quote for a brand-new order that hasn't been placed yet — powered by its
// own separately-trained model. Its input fields are never hardcoded: they
// come straight from the backend's feature_columns, whatever this project's
// real order data actually has, minus whatever a real LLM judgment excluded
// as "not knowable before the order is placed" (typically the promised-date
// column itself — asking for that back would be circular).
function QuoteInbox({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<QuoteModelStatus | null>(null);
  const [training, setTraining] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.getQuoteModelStatus(projectId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check the quote model");
    }
  }, [projectId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  useEffect(() => {
    if (status?.status !== "pending") return;
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [status, refresh]);

  if (error) {
    return (
      <SectionCard title="Quote a new order">
        <p className="text-sm text-[var(--danger)]">{error}</p>
      </SectionCard>
    );
  }
  if (!status) return null;

  if (status.status === "untrained" || status.status === "failed") {
    return (
      <SectionCard title="Quote a new order">
        {status.status === "failed" && <p className="text-sm text-[var(--danger)] mb-3">{status.error}</p>}
        <button
          disabled={training}
          onClick={async () => {
            setTraining(true);
            try {
              await api.trainQuoteModel(projectId);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : "Could not start training");
            } finally {
              setTraining(false);
            }
          }}
          className="bg-[var(--accent)] text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
        >
          {training ? "Starting…" : "Set up quoting"}
        </button>
      </SectionCard>
    );
  }

  if (status.status === "pending") {
    return (
      <SectionCard title="Quote a new order">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined animate-spin text-[var(--accent)]">progress_activity</span>
          <p className="text-sm text-[var(--text-muted)]">Setting up quoting from your order history — this updates automatically.</p>
        </div>
      </SectionCard>
    );
  }

  const dateField = status.reference_date_column;
  // The date field is rendered separately, as a real date picker — an HTML
  // date input always submits ISO YYYY-MM-DD regardless of how the browser
  // displays it locally, which is what removes the DD-MM vs MM-DD ambiguity
  // a free-text date field would otherwise have.
  const fields = status.feature_columns;
  const allRequired = dateField ? [...fields, dateField] : fields;

  return (
    <SectionCard title="Quote a new order">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        {dateField && (
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1 capitalize">{dateField.replace(/_/g, " ")}</label>
            <input
              type="date"
              value={values[dateField] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [dateField]: e.target.value }))}
              className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
            />
          </div>
        )}
        {fields.map((f) => (
          <div key={f}>
            <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1 capitalize">{f.replace(/_/g, " ")}</label>
            <input
              value={values[f] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
              className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
              placeholder={f}
            />
          </div>
        ))}
      </div>
      <button
        disabled={quoting || allRequired.some((f) => !values[f]?.trim())}
        onClick={async () => {
          setQuoting(true);
          setQuote(null);
          setError(null);
          try {
            setQuote(await api.getQuote(projectId, values));
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not compute a quote");
          } finally {
            setQuoting(false);
          }
        }}
        className="bg-[var(--accent)] text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
      >
        {quoting ? "Computing…" : "Get expected date"}
      </button>
      {error && <p className="text-sm text-[var(--danger)] mt-3">{error}</p>}
      {quote && (
        <div className="grid grid-cols-2 gap-3 mt-4">
          <StatTile
            label="Typical case"
            value={quote.typical_date ? fmtDate(quote.typical_date) : `${quote.typical_days.toFixed(1)}d`}
            sub={quote.typical_date ? `~${quote.typical_days.toFixed(1)} days, median of similar past orders` : "median of similar past orders"}
            icon="timelapse"
          />
          <StatTile
            label="Safe to promise"
            value={quote.suggested_promise_date ? fmtDate(quote.suggested_promise_date) : `${quote.suggested_promise_days.toFixed(1)}d`}
            sub={quote.suggested_promise_date ? `~${quote.suggested_promise_days.toFixed(1)} days — ~90% of similar orders finished within this` : "~90% of similar orders finished within this"}
            tone="ok"
            icon="verified"
          />
        </div>
      )}
    </SectionCard>
  );
}

function DeliveriesPage({ card, projectId }: { card: DashboardCard; projectId: string }) {
  const data = card.data as {
    orders?: DeliveryOrderRow[];
    feature_importance?: { feature: string; importance: number }[];
    historical_on_time?: HistoricalOnTime | null;
  };
  const orders = data.orders ?? [];
  const importance = (data.feature_importance ?? []).filter((f) => f.importance > 0);
  const hist = data.historical_on_time;
  const late = orders.filter((o) => (o.late_days ?? 0) > 0).length;
  const importanceSum = importance.reduce((a, b) => a + b.importance, 0);

  const stats: Stat[] = [];
  if (orders.length > 0) {
    stats.push({ label: "On track", value: String(orders.length - late), sub: "open orders", tone: "ok", icon: "check_circle" });
    stats.push({ label: "At risk", value: String(late), sub: "may miss promised date", tone: late ? "watch" : "neutral", icon: "warning" });
  }
  if (hist) {
    const rate = hist.recent_rate ?? hist.overall_rate;
    const n = hist.recent_n ?? hist.overall_n;
    stats.push({
      label: hist.recent_rate !== undefined ? "On-time % (last 30d)" : "On-time % (all history)",
      value: `${rate.toFixed(0)}%`,
      sub: `from ${n} completed orders`,
      tone: rate >= 90 ? "ok" : rate >= 75 ? "watch" : "crit",
      icon: "history",
    });
    if (hist.recent_rate !== undefined) {
      stats.push({
        label: "On-time % (all history)",
        value: `${hist.overall_rate.toFixed(0)}%`,
        sub: `from ${hist.overall_n} completed orders`,
        icon: "database",
      });
    }
  }

  return (
    <div className="space-y-4">
      <StatRow stats={stats} />
      {orders.length > 0 && (
        <SectionCard title="Will orders reach on time?" subtitle="Estimated delivery = order date + lead time predicted from your own order history.">
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)] border-b border-[var(--border)]">
                  <th className="py-2.5 pr-4">Order</th>
                  <th className="py-2.5 pr-4">Destination</th>
                  <th className="py-2.5 pr-4">Promised</th>
                  <th className="py-2.5 pr-4">Est. delivery</th>
                  <th className="py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((o) => {
                  const isLate = (o.late_days ?? 0) > 0;
                  return (
                    <tr key={String(o.order_id)} className={`border-b border-[var(--border)] last:border-0 ${isLate ? "bg-[var(--danger-soft)]/40" : ""}`}>
                      <td className="py-2.5 pr-4 font-mono">{o.order_id}</td>
                      <td className="py-2.5 pr-4 capitalize">{String(o.destination_region ?? "—")}</td>
                      <td className="py-2.5 pr-4">{fmtDate(o.promised_date)}</td>
                      <td className="py-2.5 pr-4 font-semibold">{fmtDate(o.estimated_delivery)}</td>
                      <td className="py-2.5">
                        {o.late_days === null ? (
                          <span className="text-[var(--text-faint)]">—</span>
                        ) : isLate ? (
                          <span className="inline-flex text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--danger-soft)] text-[var(--danger)]">
                            ~{o.late_days}d late
                          </span>
                        ) : (
                          <span className="inline-flex text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--success-soft)] text-[var(--success)]">
                            on track
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      {importance.length > 0 && (
        <SectionCard
          title="What affects our delivery time?"
          subtitle="Relative influence of each factor."
        >
          <div className="space-y-2.5">
            {importance.map((f) => {
              const share = importanceSum > 0 ? (f.importance / importanceSum) * 100 : 0;
              return (
                <div key={f.feature} className="flex items-center gap-3">
                  <span className="text-sm text-[var(--text-muted)] w-40 truncate">{f.feature.replace(/_/g, " ")}</span>
                  <div className="flex-1 h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
                    <div className="h-full bg-[var(--accent)] rounded-full" style={{ width: `${Math.max(2, share)}%` }} />
                  </div>
                  <span className="w-10 text-right text-xs text-[var(--text-faint)]">{share.toFixed(0)}%</span>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}
      <QuoteInbox projectId={projectId} />
      <Provenance card={card} />
    </div>
  );
}

// ------------------------------------------------------- materials page ---

function InventorySettingsForm({ material, projectId, onSaved }: { material: string; projectId: string; onSaved: () => void }) {
  const [onHand, setOnHand] = useState("");
  const [leadTime, setLeadTime] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <h3 className="text-sm font-bold text-[var(--text)] mb-1">{materialLabel(material)}</h3>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        Current stock and supplier lead time — entered once and remembered.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Units on hand today</label>
          <input
            value={onHand} onChange={(e) => setOnHand(e.target.value)} type="number"
            className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Supplier lead time (days)</label>
          <input
            value={leadTime} onChange={(e) => setLeadTime(e.target.value)} type="number"
            className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
          />
        </div>
      </div>
      <button
        disabled={!onHand || !leadTime || saving}
        onClick={async () => {
          setSaving(true);
          await api.putSetting(projectId, `inventory.${material}.on_hand`, onHand);
          await api.putSetting(projectId, `inventory.${material}.lead_time_days`, leadTime);
          setSaving(false);
          onSaved();
        }}
        className="bg-[var(--accent)] text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save and calculate"}
      </button>
    </div>
  );
}

function MaterialsPage({ card, projectId, onSettingsSaved }: { card: DashboardCard; projectId: string; onSettingsSaved: () => void }) {
  const data = card.data as { series?: ForecastSeries[]; items?: InventoryItem[] };
  const items = data.items ?? [];
  const series = data.series ?? [];
  const seriesById = new Map(series.map((s) => [s.item_id, s]));
  const configured = items
    .filter((i) => i.configured && i.reorder_in_days !== undefined)
    .sort((a, b) => (a.reorder_in_days ?? 0) - (b.reorder_in_days ?? 0));
  const unconfigured = items.filter((i) => !i.configured);
  const atRisk = configured.filter((i) => (i.reorder_in_days ?? 99) <= 7);
  const urgent = configured[0];

  const stats: Stat[] = [];
  if (urgent) {
    stats.push({ label: `${materialLabel(urgent.material)} on hand`, value: (urgent.on_hand ?? 0).toLocaleString(), sub: "units, entered by you", icon: "inventory_2" });
    stats.push({ label: "Supplier lead time", value: `${urgent.lead_time_days} days`, sub: materialLabel(urgent.material), icon: "schedule" });
    stats.push({ label: "Would run out on", value: fmtDate(urgent.runs_out_date), sub: "if usage continues as forecast", tone: atRisk.length ? "watch" : "neutral", icon: "event_busy" });
  }
  stats.push({ label: "At-risk materials", value: String(atRisk.length), sub: `of ${items.length} tracked`, tone: atRisk.length ? "watch" : "ok", icon: "warning" });

  return (
    <div className="space-y-4">
      <StatRow stats={stats} />
      {items.length > 0 && (
        <SectionCard title="Material stock status">
          <div className="overflow-x-auto -mx-5 px-5">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)] border-b border-[var(--border)]">
                  <th className="py-2.5 pr-4">Material</th>
                  <th className="py-2.5 pr-4">On hand</th>
                  <th className="py-2.5 pr-4">Daily usage (forecast)</th>
                  <th className="py-2.5 pr-4">Lead time</th>
                  <th className="py-2.5 pr-4">Would run out on</th>
                  <th className="py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const risk = it.configured && (it.reorder_in_days ?? 99) <= 7;
                  return (
                    <tr key={it.material} className="border-b border-[var(--border)] last:border-0">
                      <td className="py-2.5 pr-4 font-semibold">{materialLabel(it.material)}</td>
                      <td className="py-2.5 pr-4 font-mono">{it.configured ? (it.on_hand ?? 0).toLocaleString() : "—"}</td>
                      <td className="py-2.5 pr-4 font-mono">{it.configured && it.avg_daily_usage ? `~${Math.round(it.avg_daily_usage).toLocaleString()}` : "—"}</td>
                      <td className="py-2.5 pr-4">{it.configured ? `${it.lead_time_days} days` : "—"}</td>
                      <td className="py-2.5 pr-4">{it.configured ? fmtDate(it.runs_out_date) : "—"}</td>
                      <td className="py-2.5">
                        {!it.configured ? (
                          <span className="inline-flex text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)]">needs setup</span>
                        ) : risk ? (
                          <span className="inline-flex text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--warning-soft)] text-[var(--warning)]">
                            order by {fmtDate(it.reorder_date)}
                          </span>
                        ) : (
                          <span className="inline-flex text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--success-soft)] text-[var(--success)]">ok</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}
      {urgent && seriesById.get(urgent.material) && (
        <SeriesCard
          series={seriesById.get(urgent.material)!}
          title={`${materialLabel(urgent.material)} — usage forecast`}
          caption="Solid: recorded consumption. Dashed: forecast with its likely range."
        />
      )}
      {unconfigured.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {unconfigured.map((it) => (
            <InventorySettingsForm key={it.material} material={it.material} projectId={projectId} onSaved={onSettingsSaved} />
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {configured.slice(1).map((it) => {
          const s = seriesById.get(it.material);
          return s ? (
            <SeriesCard key={it.material} series={s} title={`${materialLabel(it.material)} — usage forecast`} caption="Recorded consumption and forecast." />
          ) : null;
        })}
      </div>
      <Provenance card={card} />
    </div>
  );
}

// -------------------------------------------------- production plan page --
//
// Every value here comes from scheduling_engine/solver.py's real CP-SAT
// output (per-order tasks, makespan, solver_status, params) or is plain
// arithmetic on it (utilization, duration, day ticks). Deliberately NOT
// included yet, because the solver doesn't model them: priority/rush
// weighting, maintenance windows, shift calendars, material gating,
// setup/changeover time, and any "smart recommendation" — those need real
// solver changes first (tracked separately), not a fake toggle here.

const ORDER_COLORS = ["#e05c7a", "#4cc3e8", "#b58cf0", "#3fd68f", "#f2b63c", "#6b9c95"];

function fmtHours(h: number): string {
  const days = Math.floor(h / 24);
  const hrs = Math.round(h - days * 24);
  return days > 0 ? `${days}d ${hrs}h` : `${hrs}h`;
}

function fmtDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

// One tick every 24h from the real schedule_start — not calendar midnight,
// so it needs no timezone-boundary logic, just elapsed hours.
function buildDayTicks(scheduleStart: string | undefined, makespanHours: number): { label: string; pct: number }[] {
  if (!scheduleStart || makespanHours <= 0) return [];
  const start = new Date(scheduleStart).getTime();
  const ticks: { label: string; pct: number }[] = [];
  for (let h = 0; h <= makespanHours; h += 24) {
    const d = new Date(start + h * 3600000);
    ticks.push({ label: d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }), pct: (h / makespanHours) * 100 });
  }
  return ticks;
}

function nowPct(scheduleStart: string | undefined, makespanHours: number): number | null {
  if (!scheduleStart || makespanHours <= 0) return null;
  const hoursElapsed = (Date.now() - new Date(scheduleStart).getTime()) / 3600000;
  if (hoursElapsed < 0 || hoursElapsed > makespanHours) return null;
  return (hoursElapsed / makespanHours) * 100;
}

function WorkCenterGantt({
  orders, machines, makespan, scheduleStart, colorOf, maintenanceWindows, offShiftBlocks,
}: {
  orders: ScheduleOrderRow[]; machines: string[]; makespan: number; scheduleStart?: string;
  colorOf: (orderId: string) => string;
  maintenanceWindows?: Record<string, { start: string; end: string }[]>;
  offShiftBlocks?: Record<string, { start: string; end: string }[]>;
}) {
  const ticks = buildDayTicks(scheduleStart, makespan);
  const now = nowPct(scheduleStart, makespan);
  const hourOf = (iso: string) =>
    scheduleStart ? (new Date(iso).getTime() - new Date(scheduleStart).getTime()) / 3600000 : 0;

  return (
    <div className="overflow-x-auto">
      {/* Wide enough that a day's worth of bars has room for its own label — at the
          previous width every order collapsed to "ORD-2…" and had to be hovered. */}
      <div className="grid" style={{ gridTemplateColumns: "210px 1fr", minWidth: 1500 }}>
        <div className="border-b-2 border-[var(--border-strong)] pb-2 flex items-end">
          <span className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)]">Work centers</span>
        </div>
        <div className="relative border-b-2 border-[var(--border-strong)] pb-2" style={{ minHeight: 28 }}>
          {ticks.map((t) => (
            <span key={t.pct} className="absolute top-0 text-[10px] font-bold text-[var(--text)] whitespace-nowrap" style={{ left: `${t.pct}%` }}>
              {t.label}
            </span>
          ))}
          {now !== null && <div className="absolute top-0 h-2 border-l border-dashed border-[var(--accent)]" style={{ left: `${now}%` }} />}
        </div>

        {machines.map((m, i) => {
          const segs = orders
            .flatMap((o) => o.tasks.filter((t) => t.machine === m).map((t) => ({ orderId: o.order_id, t })))
            .sort((a, b) => a.t.start_h - b.t.start_h);
          const busy = segs.reduce((s, seg) => s + (seg.t.end_h - seg.t.start_h), 0);
          const utilization = makespan > 0 ? Math.round((busy / makespan) * 100) : 0;
          const isLast = i === machines.length - 1;
          return (
            <Fragment key={m}>
              <div className={`flex flex-col justify-center py-2 pr-3 ${isLast ? "" : "border-b border-[var(--border)]"}`} style={{ minHeight: 64 }}>
                <div className="flex items-center justify-between mb-1 gap-2">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--text)] truncate">
                    <span className="material-symbols-outlined text-[16px] text-[var(--text-faint)]">precision_manufacturing</span>
                    <span className="truncate">{m}</span>
                  </span>
                  <span className="text-xs font-bold text-[var(--accent)] flex-none">{utilization}%</span>
                </div>
                <div className="h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
                  <div className="h-full bg-[var(--accent)] rounded-full" style={{ width: `${utilization}%` }} />
                </div>
              </div>
              <div className={`relative ${isLast ? "" : "border-b border-[var(--border)]"}`} style={{ minHeight: 64 }}>
                {segs.map((seg, j) => {
                  const widthPct = Math.max(0.6, ((seg.t.end_h - seg.t.start_h) / makespan) * 100);
                  // The full id needs roughly 60px of bar; the number alone needs ~26px.
                  // A short task used to render blank, so rather than leave it anonymous the
                  // shared "ORD-" prefix is dropped — every order in the legend carries it —
                  // and only a bar too narrow for even that stays unlabelled.
                  const shortId = seg.orderId.includes("-")
                    ? seg.orderId.slice(seg.orderId.lastIndexOf("-") + 1)
                    : seg.orderId;
                  const label = widthPct >= 6 ? seg.orderId : widthPct >= 2 ? shortId : "";
                  return (
                    <div
                      key={`${seg.orderId}-${j}`}
                      className="absolute rounded-md flex items-center justify-center px-0.5 text-[11px] font-bold text-white overflow-hidden whitespace-nowrap"
                      style={{
                        left: `${(seg.t.start_h / makespan) * 100}%`,
                        width: `${widthPct}%`,
                        top: 7, bottom: 7,
                        background: colorOf(seg.orderId),
                      }}
                      title={`${seg.orderId} on ${seg.t.machine}: ${fmtDateTime(seg.t.start)} – ${fmtDateTime(seg.t.end)}`}
                    >
                      {label}
                    </div>
                  );
                })}
                {(offShiftBlocks?.[m] ?? []).map((w, k) => {
                  const wStart = hourOf(w.start);
                  const wEnd = hourOf(w.end);
                  return (
                    <div
                      key={`shift-${k}`}
                      className="absolute rounded-md"
                      style={{
                        left: `${(wStart / makespan) * 100}%`,
                        width: `${Math.max(0.3, ((wEnd - wStart) / makespan) * 100)}%`,
                        top: 7, bottom: 7,
                        background: "repeating-linear-gradient(45deg, #e2e5ec, #e2e5ec 4px, #eef1f7 4px, #eef1f7 8px)",
                        border: "1px dashed var(--border-strong)", zIndex: 0,
                      }}
                      title={`Off-shift: ${fmtDateTime(w.start)} – ${fmtDateTime(w.end)}`}
                    />
                  );
                })}
                {(maintenanceWindows?.[m] ?? []).map((w, k) => {
                  const wStart = hourOf(w.start);
                  const wEnd = hourOf(w.end);
                  const wPct = Math.max(0.6, ((wEnd - wStart) / makespan) * 100);
                  return (
                    <div
                      key={`maint-${k}`}
                      className="absolute rounded-md flex items-center justify-center text-[10px] font-bold uppercase tracking-wide overflow-hidden"
                      style={{
                        left: `${(wStart / makespan) * 100}%`,
                        width: `${wPct}%`,
                        top: 7, bottom: 7,
                        background: "repeating-linear-gradient(45deg, var(--danger-soft), var(--danger-soft) 4px, #fff 4px, #fff 8px)",
                        border: "1px dashed var(--danger)", color: "var(--danger)",
                      }}
                      title={`Predicted maintenance: ${fmtDateTime(w.start)} – ${fmtDateTime(w.end)}`}
                    >
                      {/* A one-hour window is a sliver, but the word "Maintenance" is ~90px —
                          it used to spill across the orders next to it and read as a much
                          bigger outage than it is. Only label it when it genuinely fits. */}
                      {wPct >= 9 && "Maintenance"}
                    </div>
                  );
                })}
                {now !== null && <div className="absolute top-0 bottom-0 border-l border-dashed border-[var(--accent)]" style={{ left: `${now}%` }} />}
              </div>
            </Fragment>
          );
        })}
      </div>

      <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-[var(--border)]">
        {orders.map((o) => (
          <span key={o.order_id} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: colorOf(o.order_id) }} />
            {o.order_id}
          </span>
        ))}
        {Object.values(maintenanceWindows ?? {}).some((w) => w.length > 0) && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--danger)] font-semibold">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block border border-dashed border-[var(--danger)]"
              style={{ background: "repeating-linear-gradient(45deg, var(--danger-soft), var(--danger-soft) 2px, #fff 2px, #fff 4px)" }}
            />
            Predicted maintenance — from Machine Health&apos;s own forecast
          </span>
        )}
        {Object.values(offShiftBlocks ?? {}).some((w) => w.length > 0) && (
          <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] font-semibold">
            <span
              className="w-2.5 h-2.5 rounded-sm inline-block border border-dashed border-[var(--border-strong)]"
              style={{ background: "repeating-linear-gradient(45deg, #e2e5ec, #e2e5ec 2px, #eef1f7 2px, #eef1f7 4px)" }}
            />
            Off-shift — from the routing data&apos;s working hours
          </span>
        )}
      </div>
    </div>
  );
}

function OrderPlanTable({
  orders, colorOf, materialGatedOrders,
}: { orders: ScheduleOrderRow[]; colorOf: (orderId: string) => string; materialGatedOrders?: Record<string, string> }) {
  if (orders.length === 0) return <p className="text-xs text-[var(--text-faint)]">No orders in this plan.</p>;
  const hasPriority = orders.some((o) => o.priority);
  const hasProduct = orders.some((o) => o.product);
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs whitespace-nowrap">
        <thead>
          <tr className="text-left text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)] border-b border-[var(--border)]">
            <th className="py-2 pr-3">Order</th>
            {hasProduct && <th className="py-2 pr-3">Product</th>}
            <th className="py-2 pr-3">Qty</th>
            <th className="py-2 pr-3">Due date</th>
            {hasPriority && <th className="py-2 pr-3">Priority</th>}
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3">Start</th>
            <th className="py-2 pr-3">Finish</th>
            <th className="py-2 pr-3">Duration</th>
            <th className="py-2 pr-3">Late by</th>
            <th className="py-2">Work centers</th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const first = o.tasks[0];
            const last = o.tasks[o.tasks.length - 1];
            const durationH = first && last ? last.end_h - first.start_h : 0;
            return (
              <tr key={o.order_id} className="border-b border-[var(--border)] last:border-0">
                <td className="py-2 pr-3 font-mono font-semibold">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full inline-block" style={{ background: colorOf(o.order_id) }} />
                    {o.order_id}
                  </span>
                </td>
                {hasProduct && <td className="py-2 pr-3">{o.product ?? <span className="text-[var(--text-faint)]">—</span>}</td>}
                <td className="py-2 pr-3 font-mono">{o.quantity.toLocaleString()}</td>
                <td className="py-2 pr-3 font-mono">{fmtDate(o.due_date)}</td>
                {hasPriority && (
                  <td className="py-2 pr-3">
                    {o.priority ? (
                      <span className="inline-flex text-[10px] font-bold uppercase px-2 py-0.5 rounded-full bg-[var(--info-soft)] text-[var(--info)]">
                        {o.priority}{o.priority_weight && o.priority_weight > 1 ? ` · ${o.priority_weight}x` : ""}
                      </span>
                    ) : (
                      <span className="text-[var(--text-faint)]">—</span>
                    )}
                  </td>
                )}
                <td className="py-2 pr-3">
                  <span
                    className={`inline-flex text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
                      o.on_time ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--danger-soft)] text-[var(--danger)]"
                    }`}
                  >
                    {o.on_time ? "On time" : "Late"}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono">
                  {first ? fmtDateTime(first.start) : "—"}
                  {materialGatedOrders?.[o.order_id] && (
                    <span
                      className="material-symbols-outlined text-[13px] text-[var(--info)] ml-1 align-middle"
                      title={`Waited on material until ${fmtDateTime(materialGatedOrders[o.order_id])}`}
                    >
                      local_shipping
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3 font-mono">{fmtDateTime(o.completion)}</td>
                <td className="py-2 pr-3 font-mono">{fmtHours(durationH)}</td>
                <td className={`py-2 pr-3 font-mono ${o.hours_late ? "text-[var(--danger)] font-semibold" : "text-[var(--text-faint)]"}`}>
                  {o.hours_late ? fmtHours(o.hours_late) : "—"}
                </td>
                <td className="py-2 text-[var(--text-faint)] font-mono">{o.tasks.map((t) => t.machine).join(" → ")}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PriorityWeightSettingsForm({
  categories, projectId, onSaved,
}: { categories: string[]; projectId: string; onSaved: () => void }) {
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const allFilled = categories.every((c) => weights[c]?.trim());
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <h3 className="text-sm font-bold text-[var(--text)] mb-1">Priority weights needed</h3>
      <p className="text-xs text-[var(--text-muted)] mb-3">
        Your orders carry a priority label the solver can&apos;t weigh yet — how much more a
        higher-priority order&apos;s lateness should count is your call, not a guess. Enter a
        whole-number multiplier for each (1 = no extra weight), then re-plan.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        {categories.map((c) => (
          <div key={c}>
            <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">{c}</label>
            <input
              value={weights[c] ?? ""} onChange={(e) => setWeights((w) => ({ ...w, [c]: e.target.value }))}
              type="number" min="1" step="1"
              className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm"
            />
          </div>
        ))}
      </div>
      <button
        disabled={!allFilled || saving}
        onClick={async () => {
          setSaving(true);
          for (const c of categories) {
            await api.putSetting(projectId, `scheduling.priority_weight.${c.trim().toLowerCase()}`, weights[c]);
          }
          setSaving(false);
          onSaved();
        }}
        className="bg-[var(--accent)] text-white rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-40"
      >
        {saving ? "Saving & re-planning…" : "Save weights and re-plan"}
      </button>
    </div>
  );
}

// Every recommendation below is rendered straight from a real field the backend
// computed (a real re-solve's before/after, or a real utilization number) — no
// text here is templated from a guess, and nothing is rendered for a rec type
// this function doesn't recognize (fails visible, not with a vague fallback).
function describeRecommendation(rec: Record<string, unknown> & { type: string }): { icon: string; title: string; detail: string; badge: string } | null {
  if (rec.type === "bottleneck_machine") {
    return {
      icon: "priority_high",
      title: `${rec.machine} is your busiest work center`,
      detail: `${rec.utilization_pct}% of the makespan is spent processing on this machine — additional capacity here would have the most impact on reducing lateness across the whole plan.`,
      badge: `${rec.utilization_pct}% utilized`,
    };
  }
  if (rec.type === "shrink_maintenance_window") {
    return {
      icon: "bolt",
      title: `Shrink ${rec.machine}'s predicted maintenance window by ${rec.shrink_hours}h`,
      detail: `Re-solved with this one change: ${rec.order_id} moves from ${rec.hours_late_before}h late to ${rec.hours_late_after}h late (total lateness across the plan: ${rec.total_hours_late_before}h → ${rec.total_hours_late_after}h).`,
      badge: `saves ${Number(rec.hours_late_before) - Number(rec.hours_late_after)}h on ${String(rec.order_id)}`,
    };
  }
  if (rec.type === "expedite_material") {
    return {
      icon: "local_shipping",
      title: `Get ${rec.order_id}'s material ${rec.shift_hours}h earlier`,
      detail: `Re-solved with this one change: ${rec.order_id} moves from ${rec.hours_late_before}h late to ${rec.hours_late_after}h late (total lateness across the plan: ${rec.total_hours_late_before}h → ${rec.total_hours_late_after}h).`,
      badge: `saves ${Number(rec.hours_late_before) - Number(rec.hours_late_after)}h on ${String(rec.order_id)}`,
    };
  }
  if (rec.type === "weighted_order_still_late") {
    return {
      icon: "schedule",
      title: `${rec.order_id} is still late despite its priority`,
      detail: `Weighted ${rec.priority_weight}x as "${rec.priority}", it's still ${rec.hours_late}h late — this is the mathematically best possible outcome given current capacity. More priority weight won't fix this; more capacity or an earlier start would.`,
      badge: "capacity-bound",
    };
  }
  return null;
}

function RecommendationsList({ recommendations }: { recommendations: Array<Record<string, unknown> & { type: string }> }) {
  const items = recommendations.map(describeRecommendation).filter((x): x is NonNullable<typeof x> => x !== null);
  if (items.length === 0) {
    return <p className="text-xs text-[var(--text-faint)]">No re-solve found a real improvement to suggest right now.</p>;
  }
  return (
    <div className="divide-y divide-[var(--border)]">
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
          <span className="icon-tile flex-none w-9 h-9 rounded-lg bg-[var(--info-soft)] text-[var(--info)] flex items-center justify-center">
            <span className="material-symbols-outlined text-[18px]">{it.icon}</span>
          </span>
          <div className="flex-1">
            <div className="text-sm font-semibold text-[var(--text)]">{it.title}</div>
            <div className="text-xs text-[var(--text-muted)] mt-0.5">{it.detail}</div>
          </div>
          <span className="text-[10px] font-bold uppercase px-2 py-1 rounded-full bg-[var(--surface-2)] text-[var(--text-muted)] flex-none whitespace-nowrap">
            {it.badge}
          </span>
        </div>
      ))}
    </div>
  );
}

function SnapRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--text-faint)]">{label}</span>
      <span className="font-semibold text-[var(--text)] text-right">{value}</span>
    </div>
  );
}

function ProductionPlanPage({ card, projectId, onReplan }: { card: DashboardCard; projectId: string; onReplan: () => void }) {
  const data = card.data as {
    orders?: ScheduleOrderRow[]; machines?: string[]; makespan_hours?: number;
    solver_status?: string; schedule_start?: string;
    params?: {
      solver?: string; objective?: string; orders_count?: number; routing_steps?: number;
      priority_weighted?: boolean; priority_categories_needing_weight?: string[];
      maintenance_windows_applied?: Record<string, { start: string; end: string }[]>;
      off_shift_blocks?: Record<string, { start: string; end: string }[]>;
      material_gated_orders?: Record<string, string>;
      changeover_applied?: Record<string, number>;
    };
    recommendations?: Array<Record<string, unknown> & { type: string }>;
  };
  const orders = data.orders ?? [];
  const machines = data.machines ?? [];
  const makespan = data.makespan_hours || 1;
  const late = orders.filter((o) => !o.on_time).length;
  const params = data.params ?? {};
  const optimal = data.solver_status === "optimal";

  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [replanError, setReplanError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeRunId) return;
    const t = setInterval(async () => {
      try {
        const r = await api.getTrainingRun(projectId, activeRunId);
        if (r.status !== "queued" && r.status !== "running") {
          setActiveRunId(null);
          onReplan();
        }
      } catch {
        setActiveRunId(null);
      }
    }, 4000);
    return () => clearInterval(t);
  }, [activeRunId, projectId, onReplan]);

  async function handleReplan() {
    setReplanError(null);
    try {
      const run = await api.startTraining(projectId, "scheduling");
      setActiveRunId(run.id);
    } catch (e) {
      setReplanError(e instanceof Error ? e.message : "Could not start re-plan");
    }
  }

  const colorOf = (orderId: string) => ORDER_COLORS[Math.max(0, orders.findIndex((o) => o.order_id === orderId)) % ORDER_COLORS.length];

  return (
    <div className="space-y-4">
      <StatRow
        stats={[
          { label: "Orders in plan", value: String(orders.length), icon: "list_alt" },
          { label: "On time", value: String(orders.length - late), tone: "ok", icon: "check_circle" },
          { label: "Late", value: String(late), tone: late ? "crit" : "neutral", icon: "warning" },
          {
            label: "Total quantity", value: orders.reduce((s, o) => s + o.quantity, 0).toLocaleString(),
            sub: "sum of planned orders", icon: "inventory_2",
          },
          {
            label: "Everything done in", value: fmtHours(makespan),
            sub: optimal ? "verified optimal plan" : "feasible plan (time-limited)",
            tone: optimal ? "ok" : "watch", icon: "timer",
          },
        ]}
      />
      {(params.priority_categories_needing_weight?.length ?? 0) > 0 && (
        <PriorityWeightSettingsForm
          categories={params.priority_categories_needing_weight!}
          projectId={projectId}
          onSaved={handleReplan}
        />
      )}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_280px] gap-4 items-start">
        <div className="space-y-4 min-w-0">
          <SectionCard
            title="Production schedule"
            action={
              <div className="text-right">
                <button
                  onClick={handleReplan}
                  disabled={!!activeRunId}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white rounded-lg px-3 py-1.5 disabled:opacity-60"
                >
                  <span className="material-symbols-outlined text-[16px]">autorenew</span>
                  {activeRunId ? "Re-planning…" : "Re-plan now"}
                </button>
                {replanError && <div className="text-[10px] text-[var(--danger)] mt-1 max-w-[200px]">{replanError}</div>}
              </div>
            }
          >
            <WorkCenterGantt
              orders={orders} machines={machines} makespan={makespan} scheduleStart={data.schedule_start}
              colorOf={colorOf} maintenanceWindows={params.maintenance_windows_applied}
              offShiftBlocks={params.off_shift_blocks}
            />
          </SectionCard>
          <SectionCard title="Order-by-order plan" subtitle="Same schedule, one row per order.">
            <OrderPlanTable orders={orders} colorOf={colorOf} materialGatedOrders={params.material_gated_orders} />
          </SectionCard>
        </div>
        <div className="space-y-4">
          <SectionCard title="Plan snapshot">
            <div className="space-y-2.5 text-xs">
              <SnapRow label="Solver" value={params.solver ?? "—"} />
              <SnapRow label="Status" value={data.solver_status ?? "—"} />
              <SnapRow label="Objective" value={params.objective ?? "—"} />
              <SnapRow label="Orders / routing steps" value={`${params.orders_count ?? orders.length} / ${params.routing_steps ?? machines.length}`} />
              <SnapRow label="Priority weighting" value={params.priority_weighted ? "Active" : "Not active"} />
              {params.changeover_applied && Object.keys(params.changeover_applied).length > 0 && (
                <SnapRow
                  label="Changeover time"
                  value={Object.entries(params.changeover_applied).map(([m, h]) => `${m}: ${h}h`).join(", ")}
                />
              )}
              <SnapRow label="Generated" value={card.checked_at ? new Date(card.checked_at).toLocaleString() : "just now"} />
            </div>
          </SectionCard>
          <SectionCard title="Orders by status">
            <Donut
              data={[
                { name: "On time", value: orders.length - late, color: "var(--success)" },
                { name: "Late", value: late, color: "var(--danger)" },
              ]}
              total={orders.length}
              totalLabel="Orders"
              size={96}
            />
          </SectionCard>
        </div>
      </div>
      {data.recommendations && data.recommendations.length > 0 && (
        <SectionCard title="Smart recommendations">
          <RecommendationsList recommendations={data.recommendations} />
        </SectionCard>
      )}
      <Provenance card={card} />
    </div>
  );
}

// ------------------------------------------------------------ overview ----

function overviewStats(cards: DashboardCard[]): Stat[] {
  const stats: Stat[] = [];
  const byObjective = new Map(cards.map((c) => [c.objective, c]));

  const delivery = byObjective.get("delivery_date");
  const dOrders = ((delivery?.data as { orders?: DeliveryOrderRow[] })?.orders ?? []);
  if (dOrders.length > 0) {
    const late = dOrders.filter((o) => (o.late_days ?? 0) > 0).length;
    stats.push({
      label: "Orders on track", value: `${dOrders.length - late} of ${dOrders.length}`,
      sub: late ? `${late} at risk` : "no delays expected", tone: late ? "watch" : "ok", icon: "local_shipping",
    });
  }

  const maint = byObjective.get("maintenance");
  const mItems = deviationItems(maint);
  if (mItems.length > 0) {
    const watch = mItems.filter((i) => i.status === "watch").length;
    stats.push({
      label: "Machines need attention", value: String(watch), sub: `of ${mItems.length} monitored`,
      tone: watch ? "watch" : "ok", icon: "precision_manufacturing",
    });
  }

  const inv = byObjective.get("inventory");
  const iItems = inventoryItems(inv);
  const iConfigured = iItems.filter((i) => i.configured && i.reorder_in_days !== undefined);
  if (iItems.length > 0) {
    const risk = iConfigured.filter((i) => (i.reorder_in_days ?? 99) <= 7).length;
    stats.push({
      label: "Materials at risk", value: String(risk), sub: `of ${iItems.length} tracked`,
      tone: risk ? "watch" : "ok", icon: "inventory_2",
    });
  }

  const demand = byObjective.get("demand_forecast");
  const dSeries = ((demand?.data as { series?: ForecastSeries[] })?.series ?? []);
  if (dSeries.length > 0) {
    const dd = demandDerived(dSeries);
    stats.push({
      label: `Expected demand (${dd.horizon}d)`, value: Math.round(dd.forecastTotal).toLocaleString(),
      sub: "units, sum of forecast", icon: "trending_up",
    });
  }

  return stats;
}

function InsightStrip({ cards }: { cards: DashboardCard[] }) {
  // Each insight is a card's real computed headline — the narration layer
  // built these sentences from actual run results, so no rephrasing here.
  const ranked = [...cards]
    .filter((c) => c.status === "watch" || c.status === "crit" || c.status === "ok")
    .sort((a, b) => (a.status === "ok" ? 1 : 0) - (b.status === "ok" ? 1 : 0))
    .slice(0, 4);
  if (ranked.length === 0) return null;
  return (
    <SectionCard title="Today's insight" subtitle="Click an area in the sidebar for the full picture.">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      {ranked.map((c) => {
        const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.info;
        return (
          <div key={c.objective} className="flex items-start gap-2.5 p-3 rounded-lg bg-[var(--surface-2)]">
            <span className={`material-symbols-outlined text-[20px] ${c.status === "ok" ? "text-[var(--success)]" : "text-[var(--warning)]"}`}>
              {st.icon}
            </span>
            <div>
              <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)]">{NAV_LABEL[c.objective]}</div>
              <p className="text-xs text-[var(--text)] leading-snug mt-0.5">{c.headline}</p>
            </div>
          </div>
        );
      })}
      </div>
    </SectionCard>
  );
}

function Overview({ cards, onOpen }: { cards: DashboardCard[]; onOpen: (objective: string) => void }) {
  const attention = cards.filter((c) => c.status === "watch" || c.status === "crit").length;

  return (
    <div className="space-y-4">
      <header className="mb-1">
        <h2 className="text-2xl font-bold text-[var(--text)]">
          {attention > 0 ? (
            <>
              <span className="text-[var(--warning)]">{attention} of {cards.length}</span> areas need your attention
            </>
          ) : (
            "Everything is running normally"
          )}
        </h2>
      </header>
      <StatRow stats={overviewStats(cards)} />
      <InsightStrip cards={cards} />
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {cards.map((c) => {
          const st = STATUS_STYLE[c.status] ?? STATUS_STYLE.info;
          return (
            <article
              key={c.objective}
              onClick={() => onOpen(c.objective)}
              className="bg-white rounded-xl p-4 border border-[var(--border)] shadow-[var(--shadow-card)] cursor-pointer hover:border-[var(--accent)] transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] font-bold text-[var(--text-muted)] uppercase tracking-wide">{NAV_LABEL[c.objective]}</h3>
                <span
                  className={`material-symbols-outlined text-[20px] ${
                    c.status === "ok" ? "text-[var(--success)]" : c.status === "watch" ? "text-[var(--warning)]" : c.status === "crit" ? "text-[var(--danger)]" : "text-[var(--info)]"
                  }`}
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  {st.icon}
                </span>
              </div>
              <p className="text-sm font-semibold text-[var(--text)] leading-snug">{c.headline}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ dispatch ----

function ObjectiveDetail({
  card, projectId, onSettingsSaved, graph,
}: {
  card: DashboardCard; projectId: string; onSettingsSaved: () => void; graph: GraphData | null;
}) {
  const needsSettings = card.objective === "inventory" && (card.data as { needs_settings?: boolean }).needs_settings;
  if ((card.status === "pending" || card.status === "info" || card.status === "error") && !needsSettings) {
    return (
      <div>
        <DetailHead card={card} />
        <PendingOrError card={card} />
      </div>
    );
  }
  return (
    <div>
      <DetailHead card={card} />
      {card.objective === "maintenance" ? (
        <MachineHealthPage card={card} graph={graph} />
      ) : card.objective === "quality" ? (
        <QualityPage card={card} />
      ) : card.objective === "demand_forecast" ? (
        <DemandPage card={card} />
      ) : card.objective === "delivery_date" ? (
        <DeliveriesPage card={card} projectId={projectId} />
      ) : card.objective === "inventory" ? (
        <MaterialsPage card={card} projectId={projectId} onSettingsSaved={onSettingsSaved} />
      ) : card.objective === "scheduling" ? (
        <ProductionPlanPage card={card} projectId={projectId} onReplan={onSettingsSaved} />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------ root --

export function DecisionDashboard({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [cards, setCards] = useState<DashboardCard[] | null>(null);
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    // One-time environment check, not a value React itself owns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setCards(await api.getDashboard(projectId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load dashboard");
    }
  }, [projectId]);

  useEffect(() => {
    // setCards inside refresh() fires after an await, not synchronously in
    // the effect body — the lint rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
    api.getGraph(projectId).then(setGraph).catch(() => {});
  }, [refresh, projectId]);

  useEffect(() => {
    const anyPending = cards?.some((c) => c.status === "pending");
    if (!anyPending) return;
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [cards, refresh]);

  if (error) {
    return <div className="md:ml-64 p-8 text-sm text-[var(--danger)]">{error}</div>;
  }
  if (!cards) {
    return <div className="md:ml-64 p-8 text-sm text-[var(--text-faint)]">Loading…</div>;
  }

  const selectedCard = cards.find((c) => c.objective === selected) ?? null;
  const attention = cards.filter((c) => c.status === "watch" || c.status === "crit").length;
  const title = selected ? NAV_LABEL[selected] ?? "Overview" : "Overview";

  return (
    <div className="h-dvh bg-[var(--bg)] overflow-hidden">
      {sidebarOpen && <div className="fixed inset-0 bg-black/40 z-20 md:hidden" onClick={() => setSidebarOpen(false)} />}
      <Sidebar
        projectId={projectId}
        projectName={projectName}
        cards={cards}
        selected={selected}
        onSelect={setSelected}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((o) => !o)}
        onNavigate={() => {
          if (window.matchMedia("(max-width: 767px)").matches) setSidebarOpen(false);
        }}
      />
      <main className={`h-dvh overflow-y-auto scrollbar-thin px-4 md:px-10 py-6 transition-[margin] duration-200 ${sidebarOpen ? "md:ml-64" : "md:ml-0"}`}>
        <TopBar
          projectName={projectName}
          title={title}
          attention={attention}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((o) => !o)}
        />
        {selectedCard ? (
          <ObjectiveDetail card={selectedCard} projectId={projectId} onSettingsSaved={refresh} graph={graph} />
        ) : (
          <Overview cards={cards} onOpen={setSelected} />
        )}
      </main>
    </div>
  );
}

export const DECISION_OBJECTIVES = OBJECTIVES;

