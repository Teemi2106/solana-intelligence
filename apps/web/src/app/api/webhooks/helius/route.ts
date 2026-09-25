import { handleHeliusWebhook } from "@swi/ingestion";
import { getDatabase } from "../../../../lib/database";
import { enqueueLiveEvents, getLiveRuntime } from "../../../../lib/live";
import { getServerConfig } from "../../../../lib/server-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Helius enhanced-webhook receiver. Public by necessity, so it authenticates every request, bounds the body, validates
 * strictly and only persists + enqueues; all processing happens in workers.
 */
export async function POST(request: Request): Promise<Response> {
  const config = getServerConfig();
  const live = getLiveRuntime();
  return handleHeliusWebhook(request, {
    enabled: config.ENABLE_LIVE_INGESTION && Boolean(config.HELIUS_WEBHOOK_SECRET),
    secret: config.HELIUS_WEBHOOK_SECRET ?? "",
    database: getDatabase(),
    enqueue: enqueueLiveEvents,
    limiter: live.limiter,
    metrics: live.metrics,
    logger: live.logger,
  });
}

export function GET(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow: "POST" } });
}
