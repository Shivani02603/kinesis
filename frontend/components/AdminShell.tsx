"use client";

// Shared sidebar+topbar shell for Tier 1 (Super Admin) and Tier 2 (Company
// Admin) consoles — the exact same Kinesis visual language the real
// Operational dashboard's own Sidebar already uses (fixed 64-wide aside,
// surface-2 background, accent-soft active state), so all three tiers feel
// like one product instead of three unrelated UIs.

export type ShellNavItem = {
  label: string;
  icon: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
};

export function TierSidebar({
  tierLabel,
  scopeName,
  nav,
  footer,
  userEmail,
  onLogout,
}: {
  tierLabel: string;
  scopeName: string;
  nav: ShellNavItem[];
  footer?: ShellNavItem[];
  userEmail: string;
  onLogout: () => void;
}) {
  return (
    <aside className="hidden md:flex fixed left-0 top-0 h-screen w-64 bg-[var(--surface-2)] flex-col py-6 border-r border-[var(--border)] z-20">
      <div className="px-5 mb-1">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 bg-[var(--accent)] rounded flex items-center justify-center">
            <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
              bolt
            </span>
          </div>
          <div className="flex flex-col leading-tight min-w-0">
            <span className="font-bold text-[var(--accent)] text-sm">Kinesis</span>
            <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider truncate max-w-[140px]">{scopeName}</span>
          </div>
        </div>
        <span className="text-[9px] font-bold uppercase tracking-widest text-[var(--text-faint)] pl-1">{tierLabel}</span>
      </div>

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto scrollbar-thin mt-4">
        {nav.map((n) => (
          <button
            key={n.label}
            onClick={n.onClick}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-colors text-sm font-semibold ${
              n.active ? "bg-[var(--accent-soft)] text-[var(--accent-hover)]" : "text-[var(--text-muted)] hover:bg-white"
            }`}
          >
            <span className="material-symbols-outlined text-[20px]">{n.icon}</span>
            <span className="flex-1 text-left truncate">{n.label}</span>
            {!!n.badge && (
              <span className="text-[10px] font-bold bg-[var(--warning-soft)] text-[var(--warning)] rounded-full px-1.5 py-0.5">
                {n.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="px-3 mt-auto pt-3 border-t border-[var(--border)] space-y-1">
        {footer?.map((n) => (
          <button
            key={n.label}
            onClick={n.onClick}
            className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[var(--text-muted)] hover:bg-white text-sm font-medium"
          >
            <span className="material-symbols-outlined text-[20px]">{n.icon}</span>
            {n.label}
          </button>
        ))}
        <div className="px-3 pt-2 text-xs text-[var(--text-faint)] truncate">{userEmail}</div>
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-[var(--text-muted)] hover:bg-white text-sm font-medium"
        >
          <span className="material-symbols-outlined text-[20px]">logout</span>
          Sign out
        </button>
      </div>
    </aside>
  );
}

export function AdminShell({
  tierLabel,
  scopeName,
  nav,
  footer,
  userEmail,
  onLogout,
  title,
  subtitle,
  headerAction,
  children,
}: {
  tierLabel: string;
  scopeName: string;
  nav: ShellNavItem[];
  footer?: ShellNavItem[];
  userEmail: string;
  onLogout: () => void;
  title: string;
  subtitle?: string;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-[var(--bg)]">
      <TierSidebar tierLabel={tierLabel} scopeName={scopeName} nav={nav} footer={footer} userEmail={userEmail} onLogout={onLogout} />

      <main className="md:ml-64 min-h-screen flex flex-col">
        <div className="flex items-center justify-between gap-3 px-6 md:px-10 py-6 flex-wrap">
          <div>
            <h1 className="text-xl font-bold text-[var(--text)]">{title}</h1>
            {subtitle && <p className="text-sm text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] bg-white border border-[var(--border)] rounded-md px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[16px]">calendar_today</span>
              {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            </span>
            {headerAction}
          </div>
        </div>
        <div className="flex-1 px-6 md:px-10 pb-10 overflow-y-auto scrollbar-thin">{children}</div>
      </main>
    </div>
  );
}

export function AdminStat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "ok" | "watch" | "crit" }) {
  const toneClass = tone === "ok" ? "text-[var(--success)]" : tone === "watch" ? "text-[var(--warning)]" : tone === "crit" ? "text-[var(--danger)]" : "text-[var(--text)]";
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-4">
      <div className="text-[10px] font-bold uppercase tracking-wide text-[var(--text-faint)]">{label}</div>
      <div className={`text-2xl font-bold font-mono leading-tight mt-1 ${toneClass}`}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-faint)] mt-0.5">{sub}</div>}
    </div>
  );
}
