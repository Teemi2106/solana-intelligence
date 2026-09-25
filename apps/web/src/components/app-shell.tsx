import Link from "next/link";

const sections = [
  ["Overview", "/dashboard"],
  ["Wallets", "/wallets"],
  ["Signals", "/signals"],
  ["Research", "/research"],
  ["System", "/system"],
] as const;

export function AppShell({ children, user }: { children: React.ReactNode; user: string }) {
  return (
    <div className="grid min-h-screen grid-cols-[220px_1fr]">
      <aside className="border-r border-[var(--border)] bg-[var(--panel-muted)] p-4">
        <div className="mb-8 border-b border-[var(--border)] pb-4">
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-[var(--accent)]">Solana Intel</p>
          <p className="mt-1 text-xs text-[var(--muted)]">Observation, not execution</p>
        </div>
        <nav className="grid gap-1">{sections.map(([label, href]) => <Link className="rounded px-3 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]" href={href} key={href}>{label}</Link>)}</nav>
        <div className="fixed bottom-4 text-xs text-[var(--muted)]">Signed in as {user}</div>
      </aside>
      <main className="min-w-0 p-6 lg:p-8">{children}</main>
    </div>
  );
}
