import "server-only";
import type { Redis } from "ioredis";
import type { RateLimiter } from "@swi/ingestion";
import { createLogger, MetricsRegistry } from "@swi/observability";
import { createQueues, createRedisConnection, enqueueNormalizeLiveEvents, enqueueReconcileSubscriptions, type AppQueues } from "@swi/queue";
import { getServerConfig } from "./server-config";

interface LiveRuntime {
  readonly redis: Redis;
  readonly queueRedis: Redis;
  readonly queues: AppQueues;
  readonly metrics: MetricsRegistry;
  readonly limiter: RateLimiter;
  readonly logger: ReturnType<typeof createLogger>;
}

const globalRuntime = globalThis as typeof globalThis & { __swiLive?: LiveRuntime };

/** Bounds a Redis-dependent step so the webhook can still acknowledge within Helius' one second window. */
export async function withDeadline<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error("DEADLINE_EXCEEDED")); }, milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function getLiveRuntime(): LiveRuntime {
  if (!globalRuntime.__swiLive) {
    const config = getServerConfig();
    const redis = createRedisConnection(config.REDIS_URL, "general");
    const queueRedis = createRedisConnection(config.REDIS_URL, "bullmq");
    redis.on("error", () => undefined);
    globalRuntime.__swiLive = {
      redis,
      queueRedis,
      queues: createQueues(queueRedis),
      metrics: new MetricsRegistry(),
      logger: createLogger({ service: "web-webhook", level: config.LOG_LEVEL }),
      limiter: {
        async hit(key, limit, windowSeconds) {
          const count = await withDeadline(redis.incr(`rate:${key}`), 300);
          if (count === 1) await withDeadline(redis.expire(`rate:${key}`, windowSeconds), 300);
          return { allowed: count <= limit };
        },
      },
    };
  }
  return globalRuntime.__swiLive;
}

export async function enqueueLiveEvents(ids: readonly string[]): Promise<void> {
  await withDeadline(enqueueNormalizeLiveEvents(getLiveRuntime().queues, ids), 400);
}

/** Desired state changed (wallet added, paused or archived): ask the worker to reconcile the provider subscription. */
export async function requestSubscriptionReconcile(reason: string): Promise<void> {
  if (!getServerConfig().ENABLE_LIVE_INGESTION) return;
  await withDeadline(enqueueReconcileSubscriptions(getLiveRuntime().queues, reason), 1_500).catch(() => undefined);
}
