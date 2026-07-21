"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, clearToken, getToken, type AuthUser } from "./api";

// Where a user lands right after login, or wherever a guard bounces them back
// to when they're authenticated but not allowed on the current page.
export function homeFor(user: AuthUser): string {
  if (user.role === "super_admin") return "/";
  if (user.role === "company_admin") return `/company/${user.project_id}`;
  return `/projects/${user.project_id}/dashboard`;
}

/**
 * Real, live-checked auth guard — no cached role trusted blindly: it always
 * re-validates the token against /api/auth/me, since a session can be revoked
 * or expire server-side at any time. `requiredRole` and/or `projectId` narrow
 * who may stay on the page; anyone else is bounced to their own real home,
 * never shown a page meant for a different tier.
 */
export function useAuthGuard(opts?: { requiredRole?: AuthUser["role"]; projectId?: string }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!getToken()) {
        router.replace("/login");
        return;
      }
      try {
        const me = await api.me();
        if (cancelled) return;
        const roleOk = !opts?.requiredRole || me.role === opts.requiredRole;
        const projectOk = !opts?.projectId || me.role === "super_admin" || me.project_id === opts.projectId;
        if (!roleOk || !projectOk) {
          router.replace(homeFor(me));
          return;
        }
        setUser(me);
        setLoading(false);
      } catch {
        if (cancelled) return;
        clearToken();
        router.replace("/login");
      }
    }
    check();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts?.requiredRole, opts?.projectId]);

  return { user, loading };
}
