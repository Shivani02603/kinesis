"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  PLANNING_OBJECTIVES,
  type PlanCompatibilityCell,
  type PlanConflict,
  type PlanConsumptionCell,
  type PlanMachine,
  type PlanProduct,
  type PlanResource,
  type PlanRun,
  type PlanningSettings,
} from "@/lib/api";
import { AdminStat } from "./AdminShell";

function SectionHeader({
  icon, title, subtitle, action,
}: { icon: string; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
      <div className="flex items-start gap-2.5">
        <span className="icon-tile flex-none w-9 h-9 rounded-lg bg-[var(--accent-soft)] text-[var(--accent-hover)] flex items-center justify-center">
          <span className="material-symbols-outlined text-[18px]">{icon}</span>
        </span>
        <div>
          <h3 className="text-sm font-extrabold leading-tight">{title}</h3>
          {subtitle && <p className="text-xs text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

function ProductsSection({
  projectId, products, onChanged,
}: { projectId: string; products: PlanProduct[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<PlanProduct | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [demandMin, setDemandMin] = useState("");
  const [demandMax, setDemandMax] = useState("");
  const [batchMin, setBatchMin] = useState("");
  const [batchMax, setBatchMax] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setEditing(null);
    setName("");
    setPrice("");
    setCost("");
    setDemandMin("");
    setDemandMax("");
    setBatchMin("");
    setBatchMax("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(p: PlanProduct) {
    setEditing(p);
    setName(p.name);
    setPrice(p.price_per_unit != null ? String(p.price_per_unit) : "");
    setCost(p.cost_per_unit != null ? String(p.cost_per_unit) : "");
    setDemandMin(p.demand_min != null ? String(p.demand_min) : "");
    setDemandMax(p.demand_max != null ? String(p.demand_max) : "");
    setBatchMin(p.batch_min != null ? String(p.batch_min) : "");
    setBatchMax(p.batch_max != null ? String(p.batch_max) : "");
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !price || !cost) return;
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      price_per_unit: Number(price),
      cost_per_unit: Number(cost),
      demand_min: demandMin ? Number(demandMin) : null,
      demand_max: demandMax ? Number(demandMax) : null,
      batch_min: batchMin ? Number(batchMin) : null,
      batch_max: batchMax ? Number(batchMax) : null,
    };
    try {
      if (editing) await api.updatePlanProduct(projectId, editing.id, body);
      else await api.createPlanProduct(projectId, body);
      setShowForm(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save product");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await api.deletePlanProduct(projectId, id);
    onChanged();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="inventory_2"
        title="Products"
        subtitle="What the factory sells"
        action={
          <button className="btn btn-outline text-xs" onClick={openAdd}>
            <span className="material-symbols-outlined text-[16px]">add</span> Add product
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-[var(--surface-2)] rounded-lg p-3 mb-3 space-y-2">
          <input
            className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
            placeholder="Product name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number" step="any"
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Price per unit (revenue)"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Cost per unit"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </div>
          {price && cost && (
            <p className="text-xs text-[var(--text-muted)]">
              Profit per unit: <span className="font-semibold text-[var(--text)]">₹{(Number(price) - Number(cost)).toLocaleString()}</span>
            </p>
          )}
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Min demand (committed)"
              value={demandMin}
              onChange={(e) => setDemandMin(e.target.value)}
            />
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Max demand (ceiling)"
              value={demandMax}
              onChange={(e) => setDemandMax(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Min batch size"
              value={batchMin}
              onChange={(e) => setBatchMin(e.target.value)}
            />
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Max batch size"
              value={batchMax}
              onChange={(e) => setBatchMax(e.target.value)}
            />
          </div>
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" disabled={saving || !name.trim() || !price || !cost}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add product"}
            </button>
            <button type="button" className="btn btn-outline text-xs" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {products.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)] py-2">No products yet — add one to start planning.</p>
      ) : (
        <div className="space-y-2">
          {products.map((p) => (
            <div
              key={p.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{p.name}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="badge badge-info">profit ₹{p.profit_per_unit}/unit</span>
                  {(p.demand_min != null || p.demand_max != null) && (
                    <span className="badge badge-neutral">demand {p.demand_min ?? 0}–{p.demand_max ?? "∞"}</span>
                  )}
                  {(p.batch_min != null || p.batch_max != null) && (
                    <span className="badge badge-neutral">batch {p.batch_min ?? 0}–{p.batch_max ?? "∞"}</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button className="btn btn-outline text-xs" onClick={() => openEdit(p)}>Edit</button>
                <button className="btn btn-outline text-xs" onClick={() => handleDelete(p.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ResourcesSection({
  projectId, resources, onChanged,
}: { projectId: string; resources: PlanResource[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<PlanResource | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [unit, setUnit] = useState("");
  const [capacity, setCapacity] = useState("");
  const [kind, setKind] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setEditing(null);
    setName("");
    setUnit("");
    setCapacity("");
    setKind("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(r: PlanResource) {
    setEditing(r);
    setName(r.name);
    setUnit(r.unit);
    setCapacity(String(r.available_capacity));
    setKind(r.kind ?? "");
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !unit.trim() || !capacity) return;
    setSaving(true);
    setError(null);
    const body = { name: name.trim(), unit: unit.trim(), available_capacity: Number(capacity), kind: kind || null };
    try {
      if (editing) await api.updatePlanResource(projectId, editing.id, body);
      else await api.createPlanResource(projectId, body);
      setShowForm(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save resource");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await api.deletePlanResource(projectId, id);
    onChanged();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="propane_tank"
        title="Resources"
        subtitle="Pooled limits — material, labor, budget"
        action={
          <button className="btn btn-outline text-xs" onClick={openAdd}>
            <span className="material-symbols-outlined text-[16px]">add</span> Add resource
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-[var(--surface-2)] rounded-lg p-3 mb-3 space-y-2">
          <input
            className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
            placeholder="Resource name (e.g. Steel, Labor, Budget)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid grid-cols-3 gap-2">
            <input
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Unit (e.g. kg, hours, ₹)"
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
            />
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Available capacity"
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
            />
            <select
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">Kind (optional)</option>
              <option value="material">Material</option>
              <option value="labor">Labor</option>
              <option value="budget">Budget</option>
              <option value="other">Other</option>
            </select>
          </div>
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" disabled={saving || !name.trim() || !unit.trim() || !capacity}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add resource"}
            </button>
            <button type="button" className="btn btn-outline text-xs" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {resources.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)] py-2">No resources yet — material, labor, or a budget cap, if any of these limit you.</p>
      ) : (
        <div className="space-y-2">
          {resources.map((r) => (
            <div
              key={r.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{r.name}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="badge badge-info">{r.available_capacity.toLocaleString()} {r.unit} available</span>
                  {r.kind && <span className="badge badge-neutral">{r.kind}</span>}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button className="btn btn-outline text-xs" onClick={() => openEdit(r)}>Edit</button>
                <button className="btn btn-outline text-xs" onClick={() => handleDelete(r.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MachinesSection({
  projectId, machines, assetNames, onChanged,
}: { projectId: string; machines: PlanMachine[]; assetNames: string[]; onChanged: () => void }) {
  const [editing, setEditing] = useState<PlanMachine | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [hours, setHours] = useState("");
  const [utilFloor, setUtilFloor] = useState("");
  const [assetName, setAssetName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function openAdd() {
    setEditing(null);
    setName("");
    setHours("");
    setUtilFloor("");
    setAssetName("");
    setError(null);
    setShowForm(true);
  }

  function openEdit(m: PlanMachine) {
    setEditing(m);
    setName(m.name);
    setHours(String(m.available_hours));
    setUtilFloor(m.utilization_floor != null ? String(m.utilization_floor * 100) : "");
    setAssetName(m.asset_name ?? "");
    setError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !hours) return;
    setSaving(true);
    setError(null);
    const body = {
      name: name.trim(),
      available_hours: Number(hours),
      utilization_floor: utilFloor ? Number(utilFloor) / 100 : null,
      asset_name: assetName || null,
    };
    try {
      if (editing) await api.updatePlanMachine(projectId, editing.id, body);
      else await api.createPlanMachine(projectId, body);
      setShowForm(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save machine");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    await api.deletePlanMachine(projectId, id);
    onChanged();
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="precision_manufacturing"
        title="Machines"
        subtitle="Each machine's hours, and which one feeds its downtime forecast"
        action={
          <button className="btn btn-outline text-xs" onClick={openAdd}>
            <span className="material-symbols-outlined text-[16px]">add</span> Add machine
          </button>
        }
      />

      {showForm && (
        <form onSubmit={handleSubmit} className="bg-[var(--surface-2)] rounded-lg p-3 mb-3 space-y-2">
          <input
            className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
            placeholder="Machine name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="number" step="any" min={0}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Available hours this period"
              value={hours}
              onChange={(e) => setHours(e.target.value)}
            />
            <input
              type="number" step="any" min={0} max={100}
              className="border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
              placeholder="Utilization floor % (optional)"
              value={utilFloor}
              onChange={(e) => setUtilFloor(e.target.value)}
            />
          </div>
          <select
            className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-sm bg-white"
            value={assetName}
            onChange={(e) => setAssetName(e.target.value)}
          >
            <option value="">Not linked to the process graph</option>
            {assetNames.map((a) => (
              <option key={a} value={a}>{a}</option>
            ))}
          </select>
          <p className="text-xs text-[var(--text-faint)]">
            Linking a real machine from your process graph lets predicted downtime automatically reduce its hours.
          </p>
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary text-xs" disabled={saving || !name.trim() || !hours}>
              {saving ? "Saving…" : editing ? "Save changes" : "Add machine"}
            </button>
            <button type="button" className="btn btn-outline text-xs" onClick={() => setShowForm(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {machines.length === 0 ? (
        <p className="text-sm text-[var(--text-faint)] py-2">No machines yet — add one to assign production to it.</p>
      ) : (
        <div className="space-y-2">
          {machines.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5"
            >
              <div className="min-w-0">
                <div className="font-semibold text-sm truncate">{m.name}</div>
                <div className="flex items-center gap-2 mt-1 flex-wrap">
                  <span className="badge badge-info">{m.available_hours}h available</span>
                  {m.utilization_floor != null && (
                    <span className="badge badge-neutral">floor ≥{Math.round(m.utilization_floor * 100)}%</span>
                  )}
                  {m.asset_name ? (
                    <span className="badge badge-confirmed">linked: {m.asset_name}</span>
                  ) : (
                    <span className="badge badge-neutral">no downtime link</span>
                  )}
                </div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button className="btn btn-outline text-xs" onClick={() => openEdit(m)}>Edit</button>
                <button className="btn btn-outline text-xs" onClick={() => handleDelete(m.id)}>Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ConsumptionMatrixSection({
  projectId, products, resources, consumption, onChanged,
}: {
  projectId: string; products: PlanProduct[]; resources: PlanResource[];
  consumption: PlanConsumptionCell[]; onChanged: () => void;
}) {
  const [cells, setCells] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const c of consumption) map[`${c.product_id}:${c.resource_id}`] = String(c.per_unit);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCells(map);
    setDirty(false);
  }, [consumption]);

  function setCell(productId: string, resourceId: string, value: string) {
    setCells((prev) => ({ ...prev, [`${productId}:${resourceId}`]: value }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: PlanConsumptionCell[] = [];
      for (const p of products) {
        for (const r of resources) {
          const raw = cells[`${p.id}:${r.id}`];
          const val = raw ? Number(raw) : 0;
          if (val > 0) payload.push({ product_id: p.id, resource_id: r.id, per_unit: val });
        }
      }
      await api.setPlanConsumption(projectId, payload);
      setDirty(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the consumption matrix");
    } finally {
      setSaving(false);
    }
  }

  if (products.length === 0 || resources.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <SectionHeader icon="grid_view" title="Resource usage per unit" />
        <p className="text-sm text-[var(--text-faint)]">
          Add at least one product and one resource to set how much of each resource a unit uses.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="grid_view"
        title="Resource usage per unit"
        subtitle="How much of each resource one unit of a product uses. Blank means none."
        action={
          <button className="btn btn-primary text-xs" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save matrix"}
          </button>
        }
      />
      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-[var(--surface-2)]">
              <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Product</th>
              {resources.map((r) => (
                <th key={r.id} className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">
                  {r.name} <span className="normal-case font-normal">({r.unit})</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-[var(--border)]">
                <td className="py-2 px-3 font-semibold whitespace-nowrap">{p.name}</td>
                {resources.map((r) => (
                  <td key={r.id} className="py-2 px-3">
                    <input
                      type="number" step="any" min={0}
                      className="w-24 border border-[var(--border)] rounded-md px-2 py-1 text-sm bg-white focus:border-[var(--accent)] outline-none"
                      value={cells[`${p.id}:${r.id}`] ?? ""}
                      onChange={(e) => setCell(p.id, r.id, e.target.value)}
                      placeholder="0"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CompatibilityMatrixSection({
  projectId, products, machines, compatibility, onChanged,
}: {
  projectId: string; products: PlanProduct[]; machines: PlanMachine[];
  compatibility: PlanCompatibilityCell[]; onChanged: () => void;
}) {
  const [cells, setCells] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const c of compatibility) map[`${c.product_id}:${c.machine_id}`] = String(c.hours_per_unit);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCells(map);
    setDirty(false);
  }, [compatibility]);

  function setCell(productId: string, machineId: string, value: string) {
    setCells((prev) => ({ ...prev, [`${productId}:${machineId}`]: value }));
    setDirty(true);
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const payload: PlanCompatibilityCell[] = [];
      for (const p of products) {
        for (const m of machines) {
          const raw = cells[`${p.id}:${m.id}`];
          const val = raw ? Number(raw) : 0;
          if (val > 0) payload.push({ product_id: p.id, machine_id: m.id, hours_per_unit: val });
        }
      }
      await api.setPlanCompatibility(projectId, payload);
      setDirty(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the compatibility matrix");
    } finally {
      setSaving(false);
    }
  }

  if (products.length === 0 || machines.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <SectionHeader icon="rule_settings" title="Machine compatibility & rate" />
        <p className="text-sm text-[var(--text-faint)]">
          Add at least one product and one machine to say which machines can make which products.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="rule_settings"
        title="Machine compatibility & rate"
        subtitle="Hours needed per unit. Blank means that machine can't make this product at all."
        action={
          <button className="btn btn-primary text-xs" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save matrix"}
          </button>
        }
      />
      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}
      <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
        <table className="text-sm w-full">
          <thead>
            <tr className="bg-[var(--surface-2)]">
              <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Product</th>
              {machines.map((m) => (
                <th key={m.id} className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">
                  {m.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((p) => (
              <tr key={p.id} className="border-t border-[var(--border)]">
                <td className="py-2 px-3 font-semibold whitespace-nowrap">{p.name}</td>
                {machines.map((m) => (
                  <td key={m.id} className="py-2 px-3">
                    <input
                      type="number" step="any" min={0}
                      className="w-24 border border-[var(--border)] rounded-md px-2 py-1 text-sm bg-white focus:border-[var(--accent)] outline-none"
                      value={cells[`${p.id}:${m.id}`] ?? ""}
                      onChange={(e) => setCell(p.id, m.id, e.target.value)}
                      placeholder="—"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PlanningSettingsSection({
  projectId, settings, onChanged,
}: { projectId: string; settings: PlanningSettings; onChanged: () => void }) {
  const [local, setLocal] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocal(settings);
  }, [settings]);

  const dirty = JSON.stringify(local) !== JSON.stringify(settings);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await api.setPlanningSettings(projectId, local);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  }

  const toggleFields: { key: keyof PlanningSettings; label: string; hint: string }[] = [
    { key: "demand_ceiling", label: "Demand ceiling", hint: "Cap each product at its max demand" },
    { key: "min_committed_order", label: "Minimum committed order", hint: "Force each product's min demand" },
    { key: "pooled_resources", label: "Material / labor / budget", hint: "Enforce the resources above" },
    { key: "batch_size", label: "Min/max batch size", hint: "Enforce each product's batch bounds" },
    { key: "utilization_floor", label: "Utilization floor", hint: "Force each machine's own utilization floor" },
  ];

  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader
        icon="tune"
        title="Goal & constraints"
        subtitle="Machine capacity and machine-product compatibility are always enforced"
        action={
          <button className="btn btn-primary text-xs" onClick={handleSave} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save settings"}
          </button>
        }
      />
      {error && <p className="text-xs text-[var(--danger)] mb-2">{error}</p>}

      <div className="mb-4">
        <label className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-1.5 block">Objective</label>
        <select
          className="w-full border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-white"
          value={local.objective}
          onChange={(e) => setLocal({ ...local, objective: e.target.value })}
        >
          {PLANNING_OBJECTIVES.map((o) => (
            <option key={o.slug} value={o.slug}>{o.label}</option>
          ))}
        </select>
      </div>

      <label className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-1.5 block">Constraints</label>
      <div className="space-y-2">
        {toggleFields.map((f) => (
          <label
            key={f.key}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 cursor-pointer"
          >
            <div>
              <div className="text-sm font-semibold">{f.label}</div>
              <div className="text-xs text-[var(--text-faint)]">{f.hint}</div>
            </div>
            <input
              type="checkbox"
              className="w-4 h-4 accent-[var(--accent)]"
              checked={Boolean(local[f.key])}
              onChange={(e) => setLocal({ ...local, [f.key]: e.target.checked })}
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function InfoCallout({ tone, icon, children }: { tone: "danger" | "warning" | "info"; icon: string; children: React.ReactNode }) {
  const toneClasses = {
    danger: "border-[var(--danger)] bg-[var(--danger-soft)]",
    warning: "border-[var(--warning)] bg-[var(--warning-soft)]",
    info: "border-[var(--info)] bg-[var(--info-soft)]",
  }[tone];
  const iconColor = { danger: "text-[var(--danger)]", warning: "text-[var(--warning)]", info: "text-[var(--info)]" }[tone];
  return (
    <div className={`mt-3 rounded-lg border p-3 flex gap-2.5 ${toneClasses}`}>
      <span className={`material-symbols-outlined text-[20px] flex-none ${iconColor}`}>{icon}</span>
      <div className="min-w-0 space-y-2 text-xs">{children}</div>
    </div>
  );
}

function ConflictDetail({ conflict }: { conflict: PlanConflict }) {
  if (conflict.kind === "capacity") {
    return (
      <div className="text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text)]">{conflict.row_name}</span> ({conflict.row_type}): needs{" "}
        {conflict.minimum_required.toLocaleString()} {conflict.unit}, has {conflict.available.toLocaleString()} {conflict.unit}.
        <ul className="ml-4 list-disc mt-1 space-y-0.5">
          {conflict.driven_by.map((d) => (
            <li key={d.product_id}>
              {d.product_name}: {d.contribution.toLocaleString()} {conflict.unit} from its minimum of {d.demand_min}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (conflict.kind === "no_compatible_machine") {
    return (
      <p className="text-[var(--text-muted)]">
        <span className="font-semibold text-[var(--text)]">{conflict.product_name}</span> has a committed minimum of{" "}
        {conflict.required.toLocaleString()}, but no machine is compatible with it.
      </p>
    );
  }
  return (
    <p className="text-[var(--text-muted)]">
      <span className="font-semibold text-[var(--text)]">{conflict.machine_name}</span>&apos;s utilization floor needs{" "}
      {conflict.floor_required_hours.toLocaleString()}h, but even running every compatible product to its own ceiling only
      reaches {conflict.max_achievable_hours.toLocaleString()}h.
    </p>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return <div className="h-10 flex items-center text-[11px] text-[var(--text-faint)]">Not enough history yet</div>;
  }
  const w = 200, h = 44, pad = 5;
  const min = Math.min(...values), max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (w - pad * 2),
    h - pad - ((v - min) / range) * (h - pad * 2),
  ]);
  const line = points.map((p) => p.join(",")).join(" ");
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  const [lastX, lastY] = points[points.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11" preserveAspectRatio="none">
      <polygon points={area} fill="var(--accent)" opacity="0.12" />
      <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lastX} cy={lastY} r="3" fill="var(--accent)" />
    </svg>
  );
}

function StackedHoursBar({ busyPct, downtimePct }: { busyPct: number; downtimePct: number }) {
  const idlePct = Math.max(0, 100 - busyPct - downtimePct);
  return (
    <div className="h-2 rounded-full overflow-hidden flex bg-[var(--surface-2)]">
      {busyPct > 0 && <div className="h-full bg-[var(--success)]" style={{ width: `${busyPct}%` }} />}
      {downtimePct > 0 && <div className="h-full bg-[var(--danger)] ml-[1px]" style={{ width: `${downtimePct}%` }} />}
      {idlePct > 0 && <div className="h-full ml-[1px]" style={{ width: `${idlePct}%` }} />}
    </div>
  );
}

function ResultsView({
  run, history,
}: { run: PlanRun; history: PlanRun[] }) {
  const outcome = run.result!.output;

  if (outcome.verdict === "empty") {
    return (
      <div className="mt-3 flex items-center gap-2 text-sm text-[var(--text-faint)]">
        <span className="material-symbols-outlined text-[18px]">info</span>
        {outcome.message}
      </div>
    );
  }
  if (outcome.verdict === "error") {
    return <InfoCallout tone="danger" icon="error">{outcome.message}</InfoCallout>;
  }
  if (outcome.verdict === "missing_inputs") {
    return (
      <InfoCallout tone="info" icon="assignment_late">
        <p className="font-semibold text-[var(--info)]">{outcome.message}</p>
        <ul className="ml-4 list-disc">
          {outcome.products.map((p) => (
            <li key={p.product_id}>{p.product_name}: missing {p.missing_field.replace("_", " ")}</li>
          ))}
        </ul>
      </InfoCallout>
    );
  }
  if (outcome.verdict === "infeasible") {
    return (
      <InfoCallout tone="danger" icon="block">
        <p className="font-semibold text-[var(--danger)]">{outcome.message}</p>
        {outcome.conflicts.map((c, i) => <ConflictDetail key={i} conflict={c} />)}
      </InfoCallout>
    );
  }

  // solved — everything below is derived straight from this run's own stored
  // snapshot (products/compatibility as they were AT SOLVE TIME) plus the
  // solved outcome, never re-fetched live state, so a past run in history
  // still renders correctly even after today's products/machines have changed.
  const productSnapshot = new Map(run.result!.inputs.products.map((p) => [p.id, p]));
  const compatSnapshot = new Map(run.result!.inputs.compatibility.map((c) => [`${c.product_id}:${c.machine_id}`, c.hours_per_unit]));
  const defectDetail = run.result!.inputs.defect_detail;

  const totalUnits = outcome.products.reduce((sum, p) => sum + p.quantity, 0);
  const totalRevenue = outcome.products.reduce((sum, p) => sum + (productSnapshot.get(p.product_id)?.price_per_unit ?? 0) * p.quantity, 0);
  const totalCost = outcome.products.reduce((sum, p) => sum + (productSnapshot.get(p.product_id)?.cost_per_unit ?? 0) * p.quantity, 0);
  const totalProfit = totalRevenue - totalCost;
  const avgUtilization = outcome.machines.length
    ? outcome.machines.reduce((sum, m) => sum + m.utilization_pct, 0) / outcome.machines.length
    : 0;
  const fulfillmentValues = outcome.products.map((p) => p.demand_fulfillment_pct).filter((v): v is number => v != null);
  const avgFulfillment = fulfillmentValues.length ? fulfillmentValues.reduce((a, b) => a + b, 0) / fulfillmentValues.length : null;
  const anyBinding = outcome.machines.some((m) => m.binding) || outcome.resources.some((r) => r.binding);
  const bottleneckCount = outcome.machines.filter((m) => m.binding).length + outcome.resources.filter((r) => r.binding).length;

  const scheduleRows = outcome.products.flatMap((p) =>
    Object.entries(p.by_machine)
      .filter(([, qty]) => qty > 0.001)
      .map(([machineId, qty]) => ({
        productName: p.name, machineId, quantity: qty,
        runTime: qty * (compatSnapshot.get(`${p.product_id}:${machineId}`) ?? 0),
      }))
  );
  const totalRunTime = scheduleRows.reduce((sum, r) => sum + r.runTime, 0);
  const machineName = (id: string) => outcome.machines.find((m) => m.machine_id === id)?.name ?? id;

  const sparklineValues = history
    .filter((r) => r.objective_value != null)
    .slice(0, 8)
    .reverse()
    .map((r) => r.objective_value as number);

  const bottleneckRows = [
    ...outcome.machines.map((m) => ({
      name: m.name, kind: "Machine capacity", binding: m.binding, shadowPrice: m.shadow_price, unit: "hr",
    })),
    ...outcome.resources.map((r) => ({
      name: r.name, kind: "Resource", binding: r.binding, shadowPrice: r.shadow_price, unit: r.unit,
    })),
  ];

  return (
    <div className="mt-4 space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AdminStat label="Total units produced" value={totalUnits.toLocaleString(undefined, { maximumFractionDigits: 0 })} />
        <AdminStat label="Total revenue" value={`₹${totalRevenue.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
        <AdminStat label="Total cost" value={`₹${totalCost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
        <AdminStat label="Profit" value={`₹${totalProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} tone="ok" />
        <AdminStat label="Avg. utilization" value={`${avgUtilization.toFixed(1)}%`} />
        <AdminStat label="Demand fulfillment" value={avgFulfillment != null ? `${avgFulfillment.toFixed(1)}%` : "—"} />
        <AdminStat
          label="Bottlenecks"
          value={String(bottleneckCount)}
          sub={`of ${bottleneckRows.length} tracked`}
          tone={anyBinding ? "watch" : "ok"}
        />
      </div>

      {outcome.degenerate_note && <InfoCallout tone="info" icon="info">{outcome.degenerate_note}</InfoCallout>}

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 items-start">
        <div className="xl:col-span-2">
          <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-2.5">Production schedule</h4>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="text-sm w-full">
              <thead>
                <tr className="bg-[var(--surface-2)]">
                  <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Product</th>
                  <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Machine</th>
                  <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Quantity</th>
                  <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Run time (hrs)</th>
                </tr>
              </thead>
              <tbody>
                {scheduleRows.map((row, i) => (
                  <tr key={i} className="border-t border-[var(--border)]">
                    <td className="py-2 px-3 font-semibold">{row.productName}</td>
                    <td className="py-2 px-3 text-[var(--text-muted)]">{machineName(row.machineId)}</td>
                    <td className="py-2 px-3 text-right font-mono">{row.quantity.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                    <td className="py-2 px-3 text-right font-mono text-[var(--text-muted)]">{row.runTime.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                  </tr>
                ))}
                {scheduleRows.length > 0 && (
                  <tr className="border-t border-[var(--border-strong)] font-bold">
                    <td className="py-2 px-3" colSpan={2}>Total</td>
                    <td className="py-2 px-3 text-right font-mono">{totalUnits.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                    <td className="py-2 px-3 text-right font-mono">{totalRunTime.toLocaleString(undefined, { maximumFractionDigits: 1 })}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bg-[var(--surface-2)] rounded-xl border border-[var(--border)] p-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-1">
            <span className="material-symbols-outlined text-[16px] text-[var(--accent)]">auto_awesome</span>
            Objective
          </div>
          <div className="text-sm font-semibold mb-3">{outcome.objective_label}</div>
          <div className="text-2xl font-bold font-mono text-[var(--accent-hover)] mb-2">
            {outcome.objective_value.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
          <Sparkline values={sparklineValues} />
          <p className="text-[11px] text-[var(--text-faint)] mt-1">Last {sparklineValues.length} plan(s) generated</p>
        </div>
      </div>

      {outcome.products.some((p) => p.demand_fulfillment_pct != null) && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-2.5">
            Demand fulfillment — % of demand met after considering defects
          </h4>
          <div className="space-y-2.5">
            {outcome.products.filter((p) => p.demand_fulfillment_pct != null).map((p) => (
              <div key={p.product_id}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-semibold text-[var(--text)]">{p.name}</span>
                  <span className="font-mono text-[var(--text-muted)]">
                    {p.demand_fulfillment_pct!.toFixed(1)}% ({p.quantity.toLocaleString(undefined, { maximumFractionDigits: 0 })} / {p.demand_max?.toLocaleString()})
                  </span>
                </div>
                <div className="h-2 bg-[var(--surface-2)] rounded-full overflow-hidden">
                  <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, p.demand_fulfillment_pct!)}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {outcome.machines.length > 0 && (
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-2.5">Machine utilization &amp; downtime</h4>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="text-sm w-full">
              <thead>
                <tr className="bg-[var(--surface-2)]">
                  <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Machine</th>
                  <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)] w-1/3">Utilization</th>
                  <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Busy (hrs)</th>
                  <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Downtime (hrs)</th>
                  <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Available (hrs)</th>
                </tr>
              </thead>
              <tbody>
                {outcome.machines.map((m) => {
                  const busyPct = m.available_hours > 0 ? (m.used_hours / m.available_hours) * 100 : 0;
                  const downtimePct = m.available_hours > 0 ? (m.downtime_hours / m.available_hours) * 100 : 0;
                  return (
                    <tr key={m.machine_id} className="border-t border-[var(--border)]">
                      <td className="py-2 px-3 font-semibold flex items-center gap-1.5">
                        {m.name}
                        {m.binding && <span className="badge badge-rejected">BOTTLENECK</span>}
                      </td>
                      <td className="py-2 px-3">
                        <StackedHoursBar busyPct={busyPct} downtimePct={downtimePct} />
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{m.used_hours.toFixed(1)}</td>
                      <td className="py-2 px-3 text-right font-mono">
                        {m.downtime_hours > 0 ? <span className="badge badge-rejected">{m.downtime_hours.toFixed(1)}</span> : "—"}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--text-muted)]">{m.available_hours.toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-4 mt-2 text-[11px] text-[var(--text-faint)]">
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-[var(--success)] inline-block" /> Busy time</span>
            <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-[var(--danger)] inline-block" /> Downtime (predicted)</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
        {outcome.quality_risk.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-2.5">Quality risk / extra units produced</h4>
            <p className="text-[11px] text-[var(--text-faint)] mb-2">Extra units ensure real demand is still met after defects.</p>
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="text-sm w-full">
                <thead>
                  <tr className="bg-[var(--surface-2)]">
                    <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Product</th>
                    <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Pred. defect rate</th>
                    <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Extra units</th>
                    <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Units to produce</th>
                    <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Demand</th>
                  </tr>
                </thead>
                <tbody>
                  {outcome.quality_risk.map((q) => (
                    <tr key={q.product_id} className="border-t border-[var(--border)]">
                      <td className="py-2 px-3 font-semibold">{q.name}</td>
                      <td className="py-2 px-3 text-right font-mono">{defectDetail ? `${(defectDetail.estimated_defect_rate * 100).toFixed(1)}%` : "—"}</td>
                      <td className="py-2 px-3 text-right font-mono">{q.extra_units.toFixed(1)}</td>
                      <td className="py-2 px-3 text-right font-mono">{q.inflated_floor.toFixed(1)}</td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--text-muted)]">{q.raw_floor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-[var(--text-faint)] mt-2 flex items-center gap-1">
              <span className="material-symbols-outlined text-[13px]">info</span>
              Units to produce = Demand / (1 − defect rate). One project-wide estimate, not per-product — no per-product defect data exists yet.
            </p>
          </div>
        )}

        {bottleneckRows.length > 0 && (
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wide text-[var(--text-faint)] mb-2.5">Bottlenecks / binding constraints (shadow prices)</h4>
            <p className="text-[11px] text-[var(--text-faint)] mb-2">Resources limiting the plan. Increasing their availability would improve the objective.</p>
            <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
              <table className="text-sm w-full">
                <thead>
                  <tr className="bg-[var(--surface-2)]">
                    <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Name</th>
                    <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Status</th>
                    <th className="text-right py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Shadow price</th>
                    <th className="text-left py-2 px-3 text-[11px] uppercase font-bold text-[var(--text-faint)]">Impact</th>
                  </tr>
                </thead>
                <tbody>
                  {bottleneckRows.map((b, i) => (
                    <tr key={i} className="border-t border-[var(--border)]">
                      <td className="py-2 px-3 font-semibold">{b.name}</td>
                      <td className="py-2 px-3">
                        <span className={`badge ${b.binding ? "badge-rejected" : "badge-confirmed"}`}>
                          {b.binding ? "Binding" : "Non-binding"}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{b.shadowPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} / {b.unit}</td>
                      <td className="py-2 px-3 text-[var(--text-muted)]">
                        {b.binding && Math.abs(b.shadowPrice) > 0.001
                          ? `+${b.shadowPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} to objective per extra ${b.unit}`
                          : "No additional benefit"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const VERDICT_BADGE: Record<string, { label: string; cls: string; icon: string }> = {
  solved: { label: "solved", cls: "badge-confirmed", icon: "check_circle" },
  infeasible: { label: "infeasible", cls: "badge-rejected", icon: "block" },
  missing_inputs: { label: "missing inputs", cls: "badge-pending", icon: "assignment_late" },
  empty: { label: "empty", cls: "badge-neutral", icon: "info" },
  error: { label: "error", cls: "badge-rejected", icon: "error" },
};

const OBJECTIVE_LABEL: Record<string, string> = Object.fromEntries(PLANNING_OBJECTIVES.map((o) => [o.slug, o.label]));

function RunHistorySection({
  runs, activeRunId, onSelect,
}: { runs: PlanRun[]; activeRunId?: string; onSelect: (id: string) => void }) {
  return (
    <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
      <SectionHeader icon="history" title="Plan history" subtitle="Every past plan, saved exactly as it was solved" />
      <div className="space-y-1">
        {runs.map((r) => {
          const badge = VERDICT_BADGE[r.status] ?? { label: r.status, cls: "badge-neutral", icon: "circle" };
          return (
            <button
              key={r.id}
              onClick={() => onSelect(r.id)}
              className={`w-full flex items-center justify-between gap-2 text-sm py-2 px-2.5 rounded-lg text-left transition-colors ${
                activeRunId === r.id ? "bg-[var(--surface-2)]" : "hover:bg-[var(--surface-2)]"
              }`}
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-[var(--text-faint)] flex-none">{new Date(r.created_at).toLocaleString()}</span>
                {r.objective && <span className="text-[var(--text-muted)] truncate">{OBJECTIVE_LABEL[r.objective] ?? r.objective}</span>}
              </span>
              <span className="flex items-center gap-2 flex-none">
                {r.objective_value != null && (
                  <span className="font-mono text-xs text-[var(--text-muted)]">
                    {r.objective_value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
                  </span>
                )}
                <span className={`badge ${badge.cls} flex items-center gap-1`}>
                  <span className="material-symbols-outlined text-[13px]">{badge.icon}</span>
                  {badge.label}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ProductionMixPanel({ projectId }: { projectId: string }) {
  const [products, setProducts] = useState<PlanProduct[]>([]);
  const [resources, setResources] = useState<PlanResource[]>([]);
  const [machines, setMachines] = useState<PlanMachine[]>([]);
  const [consumption, setConsumption] = useState<PlanConsumptionCell[]>([]);
  const [compatibility, setCompatibility] = useState<PlanCompatibilityCell[]>([]);
  const [settings, setSettings] = useState<PlanningSettings | null>(null);
  const [assetNames, setAssetNames] = useState<string[]>([]);
  const [runs, setRuns] = useState<PlanRun[]>([]);
  const [latestRun, setLatestRun] = useState<PlanRun | null>(null);
  const [solving, setSolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [p, r, m, c, cm, s, graph, runList] = await Promise.all([
        api.listPlanProducts(projectId),
        api.listPlanResources(projectId),
        api.listPlanMachines(projectId),
        api.getPlanConsumption(projectId),
        api.getPlanCompatibility(projectId),
        api.getPlanningSettings(projectId),
        api.getGraph(projectId),
        api.listPlanRuns(projectId),
      ]);
      setProducts(p);
      setResources(r);
      setMachines(m);
      setConsumption(c);
      setCompatibility(cm);
      setSettings(s);
      setAssetNames(graph.nodes.filter((n) => n.label === "Asset").map((n) => n.name));
      setRuns(runList);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load production-mix data");
    }
  }, [projectId]);

  useEffect(() => {
    // refresh() sets state after its own awaits resolve, not synchronously in
    // the effect body — the lint rule can't see through the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  async function handleSolve() {
    setSolving(true);
    setError(null);
    try {
      const run = await api.solvePlan(projectId);
      setLatestRun(run);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate a plan");
    } finally {
      setSolving(false);
    }
  }

  async function handleSelectRun(runId: string) {
    try {
      const run = await api.getPlanRun(projectId, runId);
      setLatestRun(run);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load that plan");
    }
  }

  return (
    <div className="space-y-5">
      {error && (
        <div className="bg-white rounded-xl border border-[var(--danger)] p-4 text-sm text-[var(--danger)] flex items-center gap-2">
          <span className="material-symbols-outlined text-[18px]">error</span>
          {error}
        </div>
      )}

      {settings && <PlanningSettingsSection projectId={projectId} settings={settings} onChanged={refresh} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ProductsSection projectId={projectId} products={products} onChanged={refresh} />
        <MachinesSection projectId={projectId} machines={machines} assetNames={assetNames} onChanged={refresh} />
      </div>

      <ResourcesSection projectId={projectId} resources={resources} onChanged={refresh} />

      <CompatibilityMatrixSection
        projectId={projectId} products={products} machines={machines}
        compatibility={compatibility} onChanged={refresh}
      />

      <ConsumptionMatrixSection
        projectId={projectId} products={products} resources={resources}
        consumption={consumption} onChanged={refresh}
      />

      <div className="bg-white rounded-xl border border-[var(--border)] shadow-[var(--shadow-card)] p-5">
        <SectionHeader
          icon="auto_awesome"
          title="Generate plan"
          subtitle="Solves for whichever goal is selected above, within whichever constraints are turned on"
          action={
            <button className="btn btn-primary" onClick={handleSolve} disabled={solving || products.length === 0 || machines.length === 0}>
              {solving ? "Solving…" : "Generate plan"}
            </button>
          }
        />
        {latestRun?.result && <ResultsView run={latestRun} history={runs} />}
      </div>

      {runs.length > 0 && <RunHistorySection runs={runs} activeRunId={latestRun?.id} onSelect={handleSelectRun} />}
    </div>
  );
}
