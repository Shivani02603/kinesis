"use client";

import { useEffect, useState } from "react";

// Shared sidebar+topbar shell for Tier 1 (Super Admin) and Tier 2 (Company
// Admin) consoles — the exact same Kinesis visual language the real
// Operational dashboard's own Sidebar already uses (fixed 64-wide aside,
// surface-2 background, accent-soft active state), so all three tiers feel
// like one product instead of three unrelated UIs.
//
// The sidebar is a toggleable drawer on every screen size (not just hidden
// below md) — closed by default on phones so it doesn't cover the page on
// first load, open by default on desktop, and closable/reopenable either way
// from the single menu button in the header.

export type ShellNavItem = {
  label: string;
  icon: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
};

export function TierSidebar({
  scopeName,
  nav,
  footer,
  userEmail,
  onLogout,
  open,
  onToggle,
  onNavigate,
}: {
  scopeName: string;
  nav: ShellNavItem[];
  footer?: ShellNavItem[];
  userEmail: string;
  onLogout: () => void;
  open: boolean;
  onToggle: () => void;
  onNavigate?: () => void;
}) {
  return (
    <aside
      className={`fixed left-0 top-0 h-dvh w-64 bg-[var(--surface-2)] flex flex-col py-6 border-r border-[var(--border)] z-30 transition-transform duration-200 ${
        open ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      <div className="px-5 mb-1">
        <div className="flex items-center justify-between gap-2 mb-1">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 bg-[var(--accent)] rounded flex items-center justify-center flex-none">
              <span className="material-symbols-outlined text-white text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>
                bolt
              </span>
            </div>
            <div className="flex flex-col leading-tight min-w-0">
              <span className="font-bold text-[var(--accent)] text-sm">Kinesis</span>
              <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider truncate max-w-[140px]">{scopeName}</span>
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

      <nav className="flex-1 px-3 space-y-1 overflow-y-auto scrollbar-thin mt-4">
        {nav.map((n) => (
          <button
            key={n.label}
            onClick={() => {
              n.onClick();
              onNavigate?.();
            }}
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
  const [open, setOpen] = useState(true);

  // Default closed on phones (so the drawer doesn't cover the page on first
  // load) and open on desktop — decided once, after mount, since the actual
  // viewport is unknown during server render.
  useEffect(() => {
    // One-time environment check, not a value React itself owns — safe to
    // set synchronously here, same as the other viewport checks in this app.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (window.matchMedia("(max-width: 767px)").matches) setOpen(false);
  }, []);

  return (
    <div className="h-dvh bg-[var(--bg)] overflow-hidden">
      {open && <div className="fixed inset-0 bg-black/40 z-20 md:hidden" onClick={() => setOpen(false)} />}
      <TierSidebar
        scopeName={scopeName}
        nav={nav}
        footer={footer}
        userEmail={userEmail}
        onLogout={onLogout}
        open={open}
        onToggle={() => setOpen((o) => !o)}
        onNavigate={() => {
          if (window.matchMedia("(max-width: 767px)").matches) setOpen(false);
        }}
      />

      <main className={`h-dvh flex flex-col transition-[margin] duration-200 ${open ? "md:ml-64" : "md:ml-0"}`}>
        <div className="flex items-center gap-3 px-4 md:px-10 py-6 flex-wrap justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {!open && (
              <button
                onClick={() => setOpen(true)}
                className="flex-none inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-white text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                aria-label="Open menu"
              >
                <span className="material-symbols-outlined text-[20px]">menu</span>
              </button>
            )}
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-[var(--text)] truncate">{title}</h1>
              {subtitle && <p className="text-sm text-[var(--text-muted)] mt-0.5 truncate">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-[var(--text-muted)] bg-white border border-[var(--border)] rounded-md px-2.5 py-1.5">
              <span className="material-symbols-outlined text-[16px]">calendar_today</span>
              {new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
            </span>
            {headerAction}
          </div>
        </div>
        <div className="flex-1 min-h-0 px-4 md:px-10 pb-10 overflow-y-auto scrollbar-thin">{children}</div>
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
