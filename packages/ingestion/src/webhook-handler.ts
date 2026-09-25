import { heliusWebhookPayload, MAX_WEBHOOK_BODY_BYTES, verifyHeliusAuthorization } from "@swi/blockchain";
import type { Database } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";
import { markEventsQueued, recordLiveEvents } from "./live-events";

export interface RateLimiter {
  /** Counts a hit and reports whether it is still within `limit` per `windowSeconds`. */
  hit(key: string, limit: number, windowSeconds: number): Promise<{ readonly allowed: boolean }>;
}

export interface WebhookLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface WebhookDependencies {
  readonly enabled: boolean;
  readonly secret: string;
  readonly database: Database;
  /** Enqueues normalization jobs. Failure is tolerated: events are already durable and the sweeper recovers them. */
  readonly enqueue: (providerEventIds: readonly string[]) => Promise<void>;
  readonly limiter: RateLimiter;
  readonly metrics: MetricsRegistry;
  readonly logger: WebhookLogger;
  readonly limits?: { readonly perMinute: number; readonly authFailuresPerMinute: number };
}

const json = (body: Record<string, unknown>, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** Reads at most `maxBytes`; returns null as soon as the limit is exceeded so an oversized body is never buffered. */
async function readBounded(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Helius webhook request path: authenticate, bound, validate, persist, enqueue, acknowledge.
 * No history reconstruction, pricing, scoring or notifications happen here; Helius requires a 200 within one second.
 */
export async function handleHeliusWebhook(request: Request, dependencies: WebhookDependencies): Promise<Response> {
  const { metrics, logger } = dependencies;
  const limits = dependencies.limits ?? { perMinute: 1_200, authFailuresPerMinute: 20 };
  const reject = (status: number, reason: string, message: string) => {
    metrics.increment("webhook_requests_total", { outcome: "rejected", reason });
    return json({ error: message }, status);
  };
  if (!dependencies.enabled) return json({ error: "not found" }, 404);
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405, { allow: "POST" });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ?? "unknown";
  try {
    if (!(await dependencies.limiter.hit(`webhook:ip:${ip}`, limits.perMinute, 60)).allowed) return reject(429, "rate_limited", "too many requests");
  } catch (error) {
    // Availability over strictness: authentication below still applies if the limiter store is down.
    logger.warn({ reason: error instanceof Error ? error.name : "unknown" }, "webhook rate limiter unavailable");
  }

  if (!verifyHeliusAuthorization(request.headers.get("authorization"), dependencies.secret)) {
    let limited = false;
    try {
      limited = !(await dependencies.limiter.hit(`webhook:auth-fail:${ip}`, limits.authFailuresPerMinute, 60)).allowed;
    } catch {
      limited = false;
    }
    logger.warn({ ip }, "webhook authentication failed");
    return limited ? reject(429, "auth_rate_limited", "too many requests") : reject(401, "unauthorized", "unauthorized");
  }

  const body = await readBounded(request, MAX_WEBHOOK_BODY_BYTES).catch(() => null);
  if (body === null) return reject(413, "too_large", "payload too large");
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return reject(400, "malformed_json", "invalid payload");
  }
  const parsed = heliusWebhookPayload.safeParse(raw);
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues.length }, "webhook payload failed validation");
    return reject(400, "invalid_schema", "invalid payload");
  }

  try {
    const recorded = await recordLiveEvents(dependencies.database, parsed.data);
    metrics.increment("webhook_events_total", { result: "accepted" }, recorded.accepted.length);
    metrics.increment("webhook_events_total", { result: "duplicate" }, recorded.duplicates);
    metrics.increment("webhook_requests_total", { outcome: "accepted", reason: "ok" });
    if (recorded.accepted.length > 0) {
      const ids = recorded.accepted.map((event) => event.id);
      try {
        await dependencies.enqueue(ids);
        await markEventsQueued(dependencies.database, ids);
      } catch (error) {
        metrics.increment("webhook_enqueue_failures_total");
        logger.error({ reason: error instanceof Error ? error.name : "unknown", events: ids.length }, "webhook enqueue failed; sweeper will recover persisted events");
      }
    }
    logger.info({ accepted: recorded.accepted.length, duplicates: recorded.duplicates }, "webhook delivery accepted");
    return json({ accepted: recorded.accepted.length, duplicates: recorded.duplicates }, 200);
  } catch (error) {
    // Nothing was durably stored: ask Helius to retry. No internals in the response.
    metrics.increment("webhook_requests_total", { outcome: "error", reason: "persist_failed" });
    logger.error({ reason: error instanceof Error ? error.name : "unknown" }, "webhook persistence failed");
    return json({ error: "temporarily unavailable" }, 503);
  }
}
