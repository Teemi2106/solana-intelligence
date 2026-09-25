import { Suspense } from "react";
import { LoginForm } from "./login-form";

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center p-6">
      <section className="w-full max-w-sm rounded-md border border-[var(--border)] bg-[var(--panel)] p-6">
        <p className="mb-2 font-mono text-xs uppercase tracking-[0.2em] text-[var(--accent)]">Private terminal</p>
        <h1 className="mb-2 text-xl font-semibold">Solana Intelligence</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">Authenticate to access monitored wallet and signal data.</p>
        <Suspense><LoginForm /></Suspense>
      </section>
    </main>
  );
}
