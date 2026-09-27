import { Redis, type RedisOptions } from "ioredis";

export type RedisConnectionPurpose = "general" | "bullmq";

const commonOptions = {
  enableReadyCheck: true,
  connectTimeout: 10_000,
} satisfies RedisOptions;

// Keep reconnecting for the lifetime of a long-running process. Ordinary commands are still bounded by
// maxRetriesPerRequest and commandTimeout below; returning null here permanently closes the shared connection and
// makes a transient Redis outage unrecoverable without a process restart. BullMQ explicitly requires a persistent
// connection because its blocking commands use maxRetriesPerRequest: null.
const retryStrategy = (attempt: number): number =>
  Math.min(attempt * 250, 5_000);

export function redisConnectionOptions(
  purpose: RedisConnectionPurpose,
): RedisOptions {
  return {
    ...commonOptions,
    lazyConnect: true,
    keepAlive: 10_000,
    retryStrategy,
    ...(purpose === "bullmq"
      ? { maxRetriesPerRequest: null }
      : { maxRetriesPerRequest: 3, commandTimeout: 10_000 }),
  };
}

export function createRedisConnection(
  redisUrl: string,
  purpose: RedisConnectionPurpose = "general",
): Redis {
  const redis = new Redis(
    redisUrl,
    redisConnectionOptions(purpose) as RedisOptions & {
      replyMapping?: "legacy";
    },
  );
  redis.on("error", () => undefined);
  return redis;
}

export async function checkRedis(
  redis: Redis,
): Promise<{ status: "up" | "down"; latencyMs: number }> {
  const started = performance.now();
  try {
    await redis.ping();
    return { status: "up", latencyMs: Math.round(performance.now() - started) };
  } catch {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - started),
    };
  }
}
