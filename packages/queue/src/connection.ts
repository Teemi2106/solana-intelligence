import { Redis, type RedisOptions } from "ioredis";

const baseOptions = {
  enableReadyCheck: true,
  maxRetriesPerRequest: null,
  connectTimeout: 10_000,
  commandTimeout: 10_000,
  retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
} satisfies RedisOptions;

export function createRedisConnection(redisUrl: string): Redis {
  return new Redis(redisUrl, baseOptions);
}

export async function checkRedis(redis: Redis): Promise<{ status: "up" | "down"; latencyMs: number }> {
  const started = performance.now();
  try {
    await redis.ping();
    return { status: "up", latencyMs: Math.round(performance.now() - started) };
  } catch {
    return { status: "down", latencyMs: Math.round(performance.now() - started) };
  }
}
