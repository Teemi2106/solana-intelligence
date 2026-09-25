import "server-only";
import { checkDatabase, getLiveSystemStatus } from "@swi/db";
import { checkRedis, queueNames } from "@swi/queue";
import { getDatabase } from "./database";
import { getLiveRuntime, withDeadline } from "./live";
import { getServerConfig } from "./server-config";

export async function getSystemStatus() {
  const config = getServerConfig();
  const runtime = getLiveRuntime();
  const [database, redis, live] = await Promise.all([checkDatabase(getDatabase()), checkRedis(runtime.redis), getLiveSystemStatus(getDatabase())]);
  const queues = await Promise.all((["transactionIngestion", "analysis", "liveMaintenance"] as const).map(async (key) => {
    try {
      const counts = await withDeadline(runtime.queues[key].getJobCounts("waiting", "active", "delayed", "failed"), 1_500);
      return { name: queueNames[key], counts: { waiting: counts["waiting"] ?? 0, active: counts["active"] ?? 0, delayed: counts["delayed"] ?? 0, failed: counts["failed"] ?? 0 }, error: false };
    } catch {
      return { name: queueNames[key], counts: { waiting: 0, active: 0, delayed: 0, failed: 0 }, error: true };
    }
  }));
  return {
    generatedAtMs: Date.now(),
    liveEnabled: config.ENABLE_LIVE_INGESTION,
    configured: { webhookSecret: Boolean(config.HELIUS_WEBHOOK_SECRET), apiKey: Boolean(config.HELIUS_API_KEY), publicUrl: config.LIVE_WEBHOOK_PUBLIC_URL ? new URL(config.LIVE_WEBHOOK_PUBLIC_URL).origin : null },
    database, redis, queues, live,
    webhookMetrics: {
      accepted: runtime.metrics.counter("webhook_events_total", { result: "accepted" }),
      duplicates: runtime.metrics.counter("webhook_events_total", { result: "duplicate" }),
      rejectedAuth: runtime.metrics.counter("webhook_requests_total", { outcome: "rejected", reason: "unauthorized" }),
      rejectedInvalid: runtime.metrics.counter("webhook_requests_total", { outcome: "rejected", reason: "invalid_schema" }) + runtime.metrics.counter("webhook_requests_total", { outcome: "rejected", reason: "malformed_json" }),
    },
  };
}
