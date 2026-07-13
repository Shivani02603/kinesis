"use client";

import { useState } from "react";
import { api, type ReviewItem } from "@/lib/api";
import { StatusBadge } from "./StatusBadge";

const KIND_TITLES: Record<string, string> = {
  ambiguous_merge: "Naming questions",
  stage_gap: "Structural gaps",
  orphan: "Unlinked entities",
  conflict: "Conflicting sources",
};

const KIND_HINTS: Record<string, string> = {
  ambiguous_merge: "Are these two the same real-world thing, described differently?",
  stage_gap: "Is this a genuine start/end point, or is a step actually missing?",
  orphan: "This has no relationship to anything else in the graph yet.",
  conflict: "Two sources disagree on order — neither is trusted automatically.",
};

function ItemDescription({ item }: { item: ReviewItem }) {
  const p = item.payload;
  switch (item.kind) {
    case "ambiguous_merge":
      return (
        <div className="text-sm">
          <p>
            <span className="font-medium">{p.entity_a_name}</span>
            {" "}<span className="text-[var(--text-faint)]">↔</span>{" "}
            <span className="font-medium">{p.entity_b_name}</span>
          </p>
          <p className="text-xs text-[var(--text-faint)] mt-0.5">{p.reasoning}</p>
        </div>
      );
    case "stage_gap":
      return (
        <p className="text-sm">
          <span className="font-medium">{p.stage_name}</span>
          <span className="text-[var(--text-faint)]"> — missing {p.missing}</span>
        </p>
      );
    case "orphan":
      return (
        <p className="text-sm">
          <span className="font-medium">{p.entity_name}</span>
          <span className="text-[var(--text-faint)]"> ({p.entity_label})</span>
        </p>
      );
    case "conflict":
      return (
        <p className="text-sm">
          <span className="font-medium">{p.entity_a_name}</span> vs{" "}
          <span className="font-medium">{p.entity_b_name}</span>
          <span className="text-[var(--text-faint)]">
            {" "}— {p.source_asserting_a_before_b} says former precedes latter, {p.source_asserting_b_before_a} says the opposite
          </span>
        </p>
      );
    default:
      return null;
  }
}

function ActionButtons({
  item,
  onResolve,
}: {
  item: ReviewItem;
  onResolve: (id: string, resolution: string) => void;
}) {
  if (item.kind === "ambiguous_merge") {
    return (
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-primary" onClick={() => onResolve(item.id, "confirmed")}>
          Same — merge
        </button>
        <button className="btn btn-outline" onClick={() => onResolve(item.id, "rejected")}>
          Different — keep separate
        </button>
      </div>
    );
  }
  if (item.kind === "conflict") {
    return (
      <button className="btn btn-outline" onClick={() => onResolve(item.id, "confirmed")}>
        Acknowledge
      </button>
    );
  }
  // stage_gap, orphan
  return (
    <div className="flex flex-wrap gap-2">
      <button className="btn btn-outline" onClick={() => onResolve(item.id, "confirmed")}>
        Legitimate — no action needed
      </button>
      <button className="btn btn-primary" onClick={() => onResolve(item.id, "needs_fix")}>
        Real issue — flag for client
      </button>
    </div>
  );
}

export function ReviewQueue({
  items,
  projectId,
  onChanged,
}: {
  items: ReviewItem[];
  projectId: string;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const grouped = items.reduce<Record<string, ReviewItem[]>>((acc, item) => {
    (acc[item.kind] ??= []).push(item);
    return acc;
  }, {});

  async function handleResolve(itemId: string, resolution: string) {
    setBusyId(itemId);
    try {
      await api.resolveReviewItem(projectId, itemId, resolution);
      onChanged();
    } finally {
      setBusyId(null);
    }
  }

  if (items.length === 0) {
    return (
      <div className="text-sm text-[var(--text-faint)] py-8 text-center">
        No pending questions — everything is resolved.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Object.entries(grouped).map(([kind, kindItems]) => (
        <div key={kind}>
          <h3 className="text-sm font-semibold mb-1">
            {KIND_TITLES[kind]} <span className="text-[var(--text-faint)] font-normal">({kindItems.length})</span>
          </h3>
          <p className="text-xs text-[var(--text-faint)] mb-2">{KIND_HINTS[kind]}</p>
          <div className="space-y-2">
            {kindItems.map((item) => (
              <div
                key={item.id}
                className="card p-3 space-y-2"
                style={{ opacity: busyId === item.id ? 0.5 : 1 }}
              >
                <div className="min-w-0">
                  <ItemDescription item={item} />
                </div>
                <div>
                  <ActionButtons item={item} onResolve={handleResolve} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
