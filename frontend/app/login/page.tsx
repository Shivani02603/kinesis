"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, getToken, setToken } from "@/lib/api";
import { homeFor } from "@/lib/useAuthGuard";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already logged in with a session that's still genuinely valid? Skip the
  // form instead of asking twice — but always re-check with the server
  // first, never just trust a token sitting in storage.
  useEffect(() => {
    if (!getToken()) return;
    api
      .me()
      .then((user) => router.replace(homeFor(user)))
      .catch(() => {});
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const { token, user } = await api.login(email.trim(), password);
      setToken(token);
      router.replace(homeFor(user));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not log in");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8 justify-center">
          <span className="material-symbols-outlined fill text-[var(--accent)]" style={{ fontSize: 28 }}>
            bolt
          </span>
          <span className="text-xl font-extrabold text-[var(--accent)]">Kinesis</span>
        </div>

        <form onSubmit={handleSubmit} className="card p-6 space-y-4">
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Email</label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-[var(--border)] rounded-md px-3 py-2 text-sm bg-[var(--bg)] focus:outline-none focus:border-[var(--accent)]"
              placeholder="you@company.com"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] mb-1">Password</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full border border-[var(--border)] rounded-md px-3 py-2 pr-9 text-sm bg-[var(--bg)] focus:outline-none focus:border-[var(--accent)]"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-faint)]"
                tabIndex={-1}
              >
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>
                  {showPassword ? "visibility_off" : "visibility"}
                </span>
              </button>
            </div>
          </div>

          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}

          <button type="submit" className="btn btn-primary w-full justify-center" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="text-xs text-[var(--text-faint)] text-center mt-4">
          No account? Ask your Super Admin or Company Admin to create one for you.
        </p>
      </div>
    </div>
  );
}
