"use client";

import { useState, type SyntheticEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    setPending(false);
    if (!response.ok) {
      setError(response.status === 429 ? "Too many attempts. Try again later." : "Invalid credentials.");
      return;
    }
    const destination = search.get("next");
    const target = destination?.startsWith("/") && !destination.startsWith("//") ? destination : "/dashboard";
    router.replace(target as Route);
    router.refresh();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-4">
      <label className="grid gap-2 text-sm text-[var(--muted)]">Username<input name="username" autoComplete="username" required className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--accent)]" /></label>
      <label className="grid gap-2 text-sm text-[var(--muted)]">Password<input name="password" type="password" autoComplete="current-password" required className="rounded border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-[var(--text)] outline-none focus:border-[var(--accent)]" /></label>
      {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
      <button disabled={pending} className="rounded bg-[var(--accent)] px-4 py-2 font-semibold text-[#07130f] disabled:opacity-60">{pending ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}
