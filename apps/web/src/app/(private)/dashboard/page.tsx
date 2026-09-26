import { CommandCenter } from "../../../components/dashboard/command-center";
import { getDashboardSummary } from "../../../lib/dashboard-data";
import { getSystemStatus } from "../../../lib/system-status";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const [summary, system] = await Promise.all([getDashboardSummary(), getSystemStatus()]);
  return <CommandCenter summary={{ ...summary, recentActivity: summary.recentActivity.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })), recentSignals: summary.recentSignals.map((signal) => ({ ...signal, detectedAt: signal.detectedAt.toISOString() })) }} system={{ nowMs: system.generatedAtMs, liveEnabled: system.liveEnabled, database: system.database, redis: system.redis, queues: system.queues, workerHeartbeat: system.live.worker?.heartbeatAt.toISOString() ?? null, lastWebhook: system.live.lastWebhookReceivedAt?.toISOString() ?? null, latencyP95: system.live.latencyMs.p95Ms, subscriptionStatus: system.live.subscription?.status ?? null, lastSyncOutcome: system.live.lastSyncRun?.outcome ?? null, unresolvedFailures: system.live.unresolvedFailures }} />;
}
