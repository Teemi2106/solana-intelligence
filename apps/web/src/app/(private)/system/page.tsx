import { getSystemStatus } from "../../../lib/system-status";

export const dynamic = "force-dynamic";

const badge = (ok: boolean, on = "healthy", off = "down") => <span className={ok ? "text-[var(--accent)]" : "text-red-400"}>{ok ? on : off}</span>;
const ago = (date: Date | null, nowMs: number) => (date === null ? "never" : `${String(Math.max(0, Math.round((nowMs - date.getTime()) / 1000)))}s ago`);

export default async function SystemPage() {
  const status = await getSystemStatus();
  const { live } = status;
  const nowMs = status.generatedAtMs;
  const heartbeatAge = live.worker ? (nowMs - live.worker.heartbeatAt.getTime()) / 1000 : null;
  return (
    <div className="grid gap-6">
      <header>
        <p className="font-mono text-xs uppercase tracking-widest text-[var(--accent)]">Operations</p>
        <h1 className="mt-1 text-2xl font-semibold">System health</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">Live monitoring is observation only: nothing here signs, trades or copies.</p>
      </header>

      <section className="grid gap-px overflow-hidden rounded border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2 lg:grid-cols-4">
        {[
          { label: "Live ingestion", value: status.liveEnabled ? <span className="text-[var(--accent)]">enabled</span> : <span className="text-[var(--muted)]">disabled (foundation-only mode)</span> },
          { label: "Database", value: badge(status.database.status === "up", `up · ${String(status.database.latencyMs)}ms`) },
          { label: "Redis", value: badge(status.redis.status === "up", `up · ${String(status.redis.latencyMs)}ms`) },
          { label: "Worker heartbeat", value: heartbeatAge === null ? <span className="text-red-400">never seen</span> : badge(heartbeatAge < 60, `${String(Math.round(heartbeatAge))}s ago`, `stale · ${String(Math.round(heartbeatAge))}s`) },
        ].map(({ label, value }) => (
          <article key={label} className="bg-[var(--panel)] p-4"><p className="text-xs uppercase text-[var(--muted)]">{label}</p><p className="mt-2 text-sm font-semibold">{value}</p></article>
        ))}
      </section>

      <Panel title="Live ingestion">
        {!status.liveEnabled ? (
          <p className="p-6 text-sm text-[var(--muted)]">Live ingestion is disabled. No provider subscription is created, no webhook is accepted and live workers are not running. Historical intelligence continues to work. Set ENABLE_LIVE_INGESTION=true together with the Helius credentials and LIVE_WEBHOOK_PUBLIC_URL to enable it.</p>
        ) : (
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Actively monitored wallets" value={`${String(live.monitoredWallets)} / ${String(live.activeWallets)}`} note="provider-confirmed / desired" />
            <Stat label="Last webhook received" value={ago(live.lastWebhookReceivedAt, nowMs)} note={live.lastWebhookReceivedAt?.toISOString() ?? ""} />
            <Stat label="Processing latency (1h)" value={live.latencyMs.p95Ms === null ? "—" : `${String(Math.round(live.latencyMs.p95Ms))}ms p95`} note={live.latencyMs.averageMs === null ? "no samples" : `avg ${String(Math.round(live.latencyMs.averageMs))}ms · ${String(live.latencyMs.samples)} events`} />
            <Stat label="Events last hour" value={Object.entries(live.eventsLastHour).map(([state, count]) => `${state.toLowerCase()} ${String(count)}`).join(" · ") || "none"} note="by processing state" />
            <Stat label="Finality (24h, live)" value={Object.entries(live.finality).map(([state, count]) => `${state} ${String(count)}`).join(" · ") || "none"} note="confirmed rows are excluded from accounting" />
            <Stat label="Webhook requests (this web process)" value={`${String(status.webhookMetrics.accepted)} accepted · ${String(status.webhookMetrics.duplicates)} duplicate`} note={`${String(status.webhookMetrics.rejectedAuth)} unauthorized · ${String(status.webhookMetrics.rejectedInvalid)} invalid`} />
            <Stat label="Unresolved failed jobs" value={String(live.unresolvedFailures)} note="dead-lettered after retries" />
            <Stat label="Configuration" value={status.configured.webhookSecret && status.configured.apiKey && status.configured.publicUrl ? "complete" : "incomplete"} note={status.configured.publicUrl ?? "no public URL"} />
          </div>
        )}
      </Panel>

      <Panel title="Provider subscription (Helius)">
        {live.subscription === null && live.lastSyncRun === null ? (
          <p className="p-6 text-sm text-[var(--muted)]">No synchronization has run yet.</p>
        ) : (
          <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Sync status" value={live.subscription?.status ?? "unknown"} note={live.subscription?.lastErrorCode ?? ""} />
            <Stat label="Webhook" value={live.subscription?.externalIdSuffix ? `…${live.subscription.externalIdSuffix}` : "none"} note={`desired ${String(live.subscription?.desiredAddressCount ?? 0)} · provider ${String(live.subscription?.providerAddressCount ?? 0)}`} />
            <Stat label="Last sync run" value={live.lastSyncRun ? `${live.lastSyncRun.outcome} · ${ago(live.lastSyncRun.startedAt, nowMs)}` : "never"} note={live.lastSyncRun?.errorCode ?? (live.lastSyncRun ? `+${String(live.lastSyncRun.added)} / -${String(live.lastSyncRun.removed)}` : "")} />
            <Stat label="Last synced" value={ago(live.subscription?.lastSyncedAt ?? null, nowMs)} note="" />
          </div>
        )}
      </Panel>

      <Panel title="Queues">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-[var(--muted)]"><tr><th className="p-3">Queue</th><th>Waiting</th><th>Active</th><th>Delayed</th><th>Failed</th></tr></thead>
          <tbody>
            {status.queues.map((queue) => (
              <tr key={queue.name} className="border-t border-[var(--border)]">
                <td className="p-3 font-mono">{queue.name}{queue.error ? " (unavailable)" : ""}</td>
                <td>{queue.counts.waiting}</td><td>{queue.counts.active}</td><td>{queue.counts.delayed}</td><td className={queue.counts.failed > 0 ? "text-red-400" : ""}>{queue.counts.failed}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Recent dead-lettered jobs">
        {live.recentFailures.length === 0 ? <p className="p-6 text-sm text-[var(--muted)]">No unresolved failures.</p> : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-[var(--muted)]"><tr><th className="p-3">Queue</th><th>Error</th><th>Attempts</th><th>Failed</th></tr></thead>
            <tbody>{live.recentFailures.map((failure) => <tr key={failure.jobId} className="border-t border-[var(--border)]"><td className="p-3 font-mono">{failure.queue}</td><td>{failure.errorCode}</td><td>{failure.attemptCount}</td><td>{failure.failedAt.toISOString()}</td></tr>)}</tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded border border-[var(--border)] bg-[var(--panel)]"><h2 className="border-b border-[var(--border)] px-4 py-3 font-medium">{title}</h2>{children}</section>;
}
function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return <div className="rounded bg-[var(--panel-muted)] p-3"><p className="text-xs uppercase text-[var(--muted)]">{label}</p><p className="mt-1 break-words font-mono text-sm">{value}</p>{note ? <p className="mt-1 break-words text-xs text-[var(--muted)]">{note}</p> : null}</div>;
}
