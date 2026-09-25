import { getDashboardSummary } from "../../../lib/dashboard-data";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const summary = await getDashboardSummary();
  const metrics = [["Monitored wallets", summary.monitoredWallets], ["Provider events", summary.eventsProcessed], ["Signals generated", summary.signalsGenerated], ["Execution mode", "Read only"]] as const;
  return (
    <div className="grid gap-6">
      <header><p className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">Operations overview</p><h1 className="mt-1 text-2xl font-semibold">Intelligence dashboard</h1><p className="mt-2 text-sm text-[var(--muted)]">Signal scores rank observable conditions; they are not probabilities of profit.</p></header>
      <section className="grid grid-cols-2 gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] lg:grid-cols-4">{metrics.map(([label, value]) => <article className="bg-[var(--panel)] p-4" key={label}><p className="text-xs uppercase tracking-wide text-[var(--muted)]">{label}</p><p className="mt-2 font-mono text-2xl">{value}</p></article>)}</section>
      <section className="rounded border border-[var(--border)] bg-[var(--panel)]"><div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3"><h2 className="font-medium">Recent signals</h2><span className="text-xs text-[var(--muted)]">Newest first</span></div>
        {summary.recentSignals.length === 0 ? <p className="p-8 text-center text-sm text-[var(--muted)]">No signals have been generated. Live ingestion is disabled by default.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="text-xs uppercase text-[var(--muted)]"><tr><th className="p-3">Token</th><th>Type</th><th>Level</th><th>Score</th><th>Detected</th></tr></thead><tbody>{summary.recentSignals.map((signal) => <tr className="border-t border-[var(--border)]" key={signal.id}><td className="p-3 font-mono">{signal.symbol ?? `${signal.mint.slice(0, 6)}…`}</td><td>{signal.type.replaceAll("_", " ")}</td><td>{signal.level}</td><td>{signal.score}/100</td><td>{signal.detectedAt.toISOString()}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  );
}
