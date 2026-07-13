"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Cell, Pie, PieChart, ResponsiveContainer } from "recharts";
import { api, OBJECTIVES, type DashboardCard, type DeliveryOrderRow, type ForecastSeries, type GraphData } from "@/lib/api";
import { ForecastChart } from "./ForecastChart";

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
  hours_late: number; on_time: boolean; tasks: ScheduleTaskRow[];
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

function TopBar({ projectName, title, attention }: { projectName: string; title: string; attention: number }) {
  // The date is computed at render time, so it advances by itself each day
  // the dashboard is opened — no stored date anywhere.
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return (
    <div className="flex items-center justify-between gap-3 mb-6 flex-wrap">
      <div className="flex items-center gap-3">
        <h1 className="text-xl font-bold text-[var(--text)]">{title}</h1>
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
  projectId, projectName, cards, selected, onSelect,
}: {
  projectId: string; projectName: string; cards: DashboardCard[];
  selected: string | null; onSelect: (objective: string | null) => void;
}) {
  const router = useRouter();
  const byObjective = new Map(cards.map((c) => [c.objective, c]));
  return (
    <aside className="hidden md:flex fixed left-0 top-0 h-screen w-64 bg-[var(--surface-2)] flex-col py-6 border-r border-[var(--border)] z-20">
      <div className="px-5 mb-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 bg-[var(--accent)] rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>factory</span>
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-bold text-[var(--accent)] text-sm">Kinesis</span>
            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider truncate max-w-[140px]">{projectName}</span>
          </div>
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
              onClick={() => onSelect(n.objective)}
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
          onClick={() => router.push(`/projects/${projectId}`)}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[var(--text-muted)] hover:bg-white text-sm font-medium"
        >
          <span className="material-symbols-outlined text-[20px]">build</span>
          Technical workspace
        </button>
        <button
          onClick={() => router.push("/")}
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
      <div className="flex items-start justify-between mb-3">
        <div>
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

function SeriesCard({ series, title, caption }: { series: ForecastSeries; title?: string; caption: string }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <h3 className="text-sm font-bold text-[var(--text)] mb-1">{title ?? series.item_id}</h3>
      <ForecastChart series={series} />
      <p className="text-xs text-[var(--text-muted)] mt-2">{caption}</p>
    </div>
  );
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
      subtitle={`${assets.length} machines in your process graph — ${coveredCount} have real sensor data uploaded. The rest appear here once their readings are provided.`}
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
            title={`${flagged.item_id} — trend`}
            caption="Solid: recorded readings. Dashed: forecast. Shaded band: learned normal range — readings outside it are a real deviation, not a guess."
          />
        )}
      </div>
      {alerts.length > 0 && (
        <SectionCard title="Recent deviations detected" subtitle="Real recorded readings that fell outside a signal's own learned normal range — not a scheduled maintenance plan, which this data can't yet support.">
          <AlertList alerts={alerts} />
        </SectionCard>
      )}
      {graph && <MachineCoverage graph={graph} monitoredNames={series.map((s) => s.item_id)} />}
      <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
        {series.filter((s) => s.item_id !== flagged?.item_id).map((s) => (
          <SeriesCard key={s.item_id} series={s} caption="Recorded readings with forecast and learned normal range." />
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
            title={`${mainSeries.item_id} — trend`}
            caption="Solid: recorded values. Dashed: forecast. Shaded band: this signal's own learned normal range."
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
        <SectionCard title="Recent quality alerts" subtitle="Real recorded readings outside the learned normal range — not a fabricated incident log.">
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
            title={`${s.item_id} — trend`}
            caption="Solid: recorded values. Dashed: forecast. Shaded band: this signal's own learned normal range."
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
          <SectionCard title="Demand insights" subtitle="Computed from this forecast — every line traces to the numbers above.">
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

function DeliveriesPage({ card }: { card: DashboardCard }) {
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
          subtitle="Relative influence of each factor, learned by the model from your own completed orders."
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
        Usage is forecast from your data, but current stock and supplier lead time are real facts only you
        know — entered once and remembered.
      </p>
      <div className="grid grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Units on hand today</label>
          <input
            value={onHand} onChange={(e) => setOnHand(e.target.value)} type="number"
            className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm" placeholder="e.g. 5200"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Supplier lead time (days)</label>
          <input
            value={leadTime} onChange={(e) => setLeadTime(e.target.value)} type="number"
            className="w-full border border-[var(--border)] rounded-lg px-3 py-2 text-sm" placeholder="e.g. 4"
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
        <SectionCard title="Material stock status" subtitle="Usage forecast from your consumption log; stock and lead times are the real numbers you entered.">
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

const MACHINE_COLORS = ["#e05c7a", "#4cc3e8", "#b58cf0", "#3fd68f", "#f2b63c", "#6b9c95"];

function PlanBars({ orders, machines, makespan }: { orders: ScheduleOrderRow[]; machines: string[]; makespan: number }) {
  const colorOf = (m: string) => MACHINE_COLORS[machines.indexOf(m) % MACHINE_COLORS.length];
  return (
    <>
      <div className="space-y-2">
        {orders.map((o) => (
          <div key={o.order_id} className="flex items-center gap-3 text-xs">
            <span className="font-mono text-[var(--text-muted)] w-20">{o.order_id}</span>
            <div className="relative flex-1 h-4 bg-[var(--surface-2)] rounded overflow-hidden">
              {o.tasks.map((t) => (
                <div
                  key={t.machine}
                  className="absolute top-0 h-full"
                  style={{
                    left: `${(t.start_h / makespan) * 100}%`,
                    width: `${Math.max(0.5, ((t.end_h - t.start_h) / makespan) * 100)}%`,
                    background: colorOf(t.machine),
                  }}
                  title={t.machine}
                />
              ))}
            </div>
            <span className={`w-16 text-right font-semibold ${o.on_time ? "text-[var(--success)]" : "text-[var(--danger)]"}`}>
              {o.on_time ? "on time" : `${o.hours_late}h late`}
            </span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 mt-4 pt-3 border-t border-[var(--border)]">
        {machines.map((m) => (
          <span key={m} className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
            <span className="w-2.5 h-2.5 rounded-sm inline-block" style={{ background: colorOf(m) }} />
            {m}
          </span>
        ))}
      </div>
    </>
  );
}

function ProductionPlanPage({ card }: { card: DashboardCard }) {
  const data = card.data as {
    orders?: ScheduleOrderRow[]; machines?: string[]; makespan_hours?: number;
    orders_on_time?: number; orders_late?: number; params?: { solver?: string };
  };
  const orders = data.orders ?? [];
  const machines = data.machines ?? [];
  const late = orders.filter((o) => !o.on_time).length;

  return (
    <div className="space-y-4">
      <StatRow
        stats={[
          { label: "Orders in plan", value: String(orders.length), icon: "list_alt" },
          { label: "On time", value: String(orders.length - late), tone: "ok", icon: "check_circle" },
          { label: "At risk", value: String(late), tone: late ? "watch" : "neutral", icon: "warning" },
          { label: "Everything done in", value: `${data.makespan_hours ?? "—"}h`, sub: "verified optimal plan", icon: "timer" },
        ]}
      />
      <SectionCard
        title="Order-by-order plan"
        subtitle="Each bar is one order moving through the machines in sequence — an exact plan from the solver, not a heuristic guess."
      >
        <PlanBars orders={orders} machines={machines} makespan={data.makespan_hours || 1} />
      </SectionCard>
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
    <SectionCard title="Today's insight" subtitle="Straight from the latest checks — click an area in the sidebar for the full picture.">
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
        <p className="text-[var(--text-muted)] text-sm mt-1">Every number below is computed from your own uploaded data — nothing is estimated by hand.</p>
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
        <DeliveriesPage card={card} />
      ) : card.objective === "inventory" ? (
        <MaterialsPage card={card} projectId={projectId} onSettingsSaved={onSettingsSaved} />
      ) : card.objective === "scheduling" ? (
        <ProductionPlanPage card={card} />
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
    <div className="h-screen overflow-y-auto bg-[var(--bg)]">
      <Sidebar projectId={projectId} projectName={projectName} cards={cards} selected={selected} onSelect={setSelected} />
      <main className="md:ml-64 px-6 md:px-10 py-6 max-w-[1600px]">
        <TopBar projectName={projectName} title={title} attention={attention} />
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
