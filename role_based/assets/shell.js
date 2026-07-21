/* ============================================================================
   Shared app shell for the role-based prototype.

   Every page sets <body data-persona="..." data-active="..."> and drops two
   empty mounts: <div id="k-sidebar-mount"></div> and <div id="k-topbar-mount">.
   This file renders the correct sidebar + topbar for that persona and wires all
   cross-navigation, so the whole prototype is one connected click-through.

   The three tiers we agreed on:
     - superadmin : platform owner (our company) — sees every client company,
                    owns Structure/Training (the Understanding Engine flow),
                    approves structure-change requests.
     - admin      : one client company's admin — read-only graph, data
                    connections, sub-users, can *request* a structure change.
     - operator personas (plant_head / maintenance / sales / planner / qc / scm)
                  : day-to-day role-scoped dashboards.
   ============================================================================ */

const PERSONAS = {
  superadmin: {
    label: "Super Admin",
    scope: "Kinesis Platform",
    scopeSub: "All client companies",
    tier: "Tier 1 · Platform",
    icon: "shield_person",
    nav: [
      { id: "companies", label: "Client companies", icon: "apartment", href: "super-admin.html" },
      { id: "requests", label: "Structure requests", icon: "inbox", href: "super-admin.html#requests" },
      { id: "onboard", label: "Structure & training", icon: "hub", href: "run-discovery.html" },
    ],
  },
  admin: {
    label: "Company Admin",
    scope: "Acme Steel Plant",
    scopeSub: "Basic Metals · 12 machines",
    tier: "Tier 2 · Company",
    icon: "admin_panel_settings",
    nav: [
      { id: "overview", label: "Company console", icon: "space_dashboard", href: "admin.html" },
      { id: "connections", label: "Data connections", icon: "cable", href: "admin-connections.html" },
      { id: "users", label: "People & roles", icon: "group", href: "admin-people.html" },
      { id: "graph", label: "Process map", icon: "account_tree", href: "admin-map.html" },
    ],
  },
  // Tier 3 is ONE unified operational dashboard, same for every operational
  // user in the company — deliberately not split into per-role apps.
  plant_head: {
    label: "Operational",
    scope: "Acme Steel Plant",
    scopeSub: "One dashboard · all areas",
    tier: "Tier 3 · Operational",
    icon: "dashboard",
    nav: [
      { id: "overview", label: "Overview", icon: "dashboard", href: "plant-head.html" },
      { id: "vitals", label: "Plant vitals", icon: "monitor_heart", href: "vitals.html" },
      { id: "maintenance", label: "Machine Health", icon: "precision_manufacturing", href: "maintenance.html" },
      { id: "quality", label: "Quality", icon: "verified", href: "#" },
      { id: "demand", label: "Demand", icon: "trending_up", href: "#" },
      { id: "deliveries", label: "Deliveries", icon: "local_shipping", href: "sales.html" },
      { id: "materials", label: "Materials", icon: "inventory_2", href: "#" },
      { id: "plan", label: "Production Plan", icon: "view_timeline", href: "production-plan.html" },
    ],
  },
};

// Demo-only role switcher — the three real tiers, nothing more.
const SWITCHER = [
  ["Tier 1 — Platform", ["superadmin"]],
  ["Tier 2 — Company", ["admin"]],
  ["Tier 3 — Operational", ["plant_head"]],
];

function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

function renderSidebar(persona, activeId) {
  const p = PERSONAS[persona];
  const links = p.nav.map((n) => `
    <a class="k-navlink ${n.id === activeId ? "active" : ""}" href="${n.href}">
      <span class="material-symbols-outlined">${n.icon}</span>
      <span>${esc(n.label)}</span>
    </a>`).join("");

  return `
    <aside class="k-sidebar scrollbar-thin">
      <div class="k-brand">
        <div class="k-brand-mark"><span class="material-symbols-outlined fill" style="font-size:18px">bolt</span></div>
        <div>
          <div class="k-brand-name">Kinesis</div>
          <div class="k-brand-sub">${esc(p.scope)}</div>
        </div>
      </div>
      <div class="k-tier-label">${esc(p.tier)}</div>
      <nav class="k-nav">${links}</nav>
      <div class="k-sidebar-foot k-nav">
        <a class="k-navlink" href="index.html">
          <span class="material-symbols-outlined">grid_view</span><span>All personas</span>
        </a>
        <a class="k-navlink" href="index.html">
          <span class="material-symbols-outlined">logout</span><span>Sign out</span>
        </a>
      </div>
    </aside>`;
}

function renderTopbar(persona, title, subtitle) {
  const p = PERSONAS[persona];
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const options = SWITCHER.map(([group, keys]) => `
    <optgroup label="${esc(group)}">
      ${keys.map((k) => `<option value="${k}" ${k === persona ? "selected" : ""}>${esc(PERSONAS[k].label)}</option>`).join("")}
    </optgroup>`).join("");

  return `
    <div class="k-topbar">
      <div>
        <h1>${esc(title)}</h1>
        <div class="k-topbar-sub">${esc(subtitle || p.scope + " · " + p.scopeSub)}</div>
      </div>
      <div style="display:flex; align-items:center; gap:.6rem;">
        <span class="k-pill"><span class="material-symbols-outlined" style="font-size:16px">calendar_today</span>${today}</span>
        <label class="k-roleswitch" title="Prototype: jump to any persona">
          <span class="material-symbols-outlined" style="font-size:16px">switch_account</span>
          Viewing as
          <select onchange="Shell.go(this.value)">${options}</select>
        </label>
      </div>
    </div>`;
}

const Shell = {
  // Where each persona's landing page lives, for the role switcher.
  home: {
    superadmin: "super-admin.html",
    admin: "admin.html",
    plant_head: "plant-head.html",
  },
  go(persona) { window.location.href = this.home[persona] || "index.html"; },
  mount() {
    const body = document.body;
    const persona = body.dataset.persona;
    const active = body.dataset.active || "";
    const title = body.dataset.title || PERSONAS[persona].label;
    const subtitle = body.dataset.subtitle || "";
    const sb = document.getElementById("k-sidebar-mount");
    const tb = document.getElementById("k-topbar-mount");
    if (sb) sb.outerHTML = renderSidebar(persona, active);
    if (tb) tb.outerHTML = renderTopbar(persona, title, subtitle);
  },
};

document.addEventListener("DOMContentLoaded", () => Shell.mount());
window.Shell = Shell;
window.PERSONAS = PERSONAS;
