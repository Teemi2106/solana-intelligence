import { Redis, type RedisOptions } from "ioredis";

export type RedisConnectionPurpose = "general" | "bullmq";

const commonOptions = {
  enableReadyCheck: true,
  connectTimeout: 10_000,
} satisfies RedisOptions;

const retryStrategy = (attempt: number): number | null =>
  attempt <= 12 ? Math.min(attempt * 250, 5_000) : null;

export type RedisFailureCategory =
  | "authentication"
  | "connection_closed"
  | "connection_refused"
  | "dns"
  | "timeout"
  | "tls"
  | "unknown";

export interface SanitizedRedisFailure {
  readonly category: RedisFailureCategory;
  readonly code: string;
  readonly errorName: string;
}

export type RedisLifecycleEvent =
  | { readonly event: "connect" | "ready" | "close" | "end"; readonly status: string }
  | { readonly event: "reconnecting"; readonly status: string; readonly delayMs: number }
  | { readonly event: "error"; readonly status: string; readonly failure: SanitizedRedisFailure };

/** Classifies a Redis failure without returning its message, URL, host, username, password or tokens. */
export function sanitizeRedisFailure(error: unknown): SanitizedRedisFailure {
  const record = typeof error === "object" && error !== null ? error as Record<string, unknown> : {};
  const code = typeof record["code"] === "string" ? record["code"].toUpperCase() : "UNKNOWN";
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  const category: RedisFailureCategory =
    code === "ENOTFOUND" || code === "EAI_AGAIN" || message.includes("getaddrinfo") ? "dns"
      : code === "ECONNREFUSED" ? "connection_refused"
        : code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || message.includes("timeout") ? "timeout"
          : code.startsWith("ERR_TLS") || code.includes("CERT") || message.includes("certificate") || message.includes("tls") ? "tls"
            : message.includes("wrongpass") || message.includes("noauth") || message.includes("authentication") ? "authentication"
              : message.includes("connection is closed") || code === "CONNECTION_CLOSED" ? "connection_closed"
                : "unknown";
  return { category, code, errorName };
}

export class RedisStartupError extends Error {
  constructor(readonly details: SanitizedRedisFailure) {
    super(`REDIS_STARTUP_FAILED category=${details.category} code=${details.code}`);
    this.name = "RedisStartupError";
  }
}

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

/** Connects and authenticates before BullMQ takes ownership; preserves the most useful sanitized transport error. */
export async function verifyRedisStartup(
  redis: Redis,
  observe: (event: RedisLifecycleEvent) => void = () => undefined,
): Promise<void> {
  let lastFailure: SanitizedRedisFailure | undefined;
  const capture = (error: Error) => {
    const failure = sanitizeRedisFailure(error);
    // ioredis can emit a generic final "Connection is closed" after the actionable transport/authentication error.
    // Keep the actionable cause while still exposing the complete sanitized event sequence to the observer.
    if (!lastFailure || failure.category !== "connection_closed") lastFailure = failure;
    observe({ event: "error", status: redis.status, failure });
  };
  const connect = () => { observe({ event: "connect", status: redis.status }); };
  const ready = () => { observe({ event: "ready", status: redis.status }); };
  const close = () => { observe({ event: "close", status: redis.status }); };
  const end = () => { observe({ event: "end", status: redis.status }); };
  const reconnecting = (delayMs: number) => { observe({ event: "reconnecting", status: redis.status, delayMs }); };
  redis.on("error", capture);
  redis.on("connect", connect);
  redis.on("ready", ready);
  redis.on("close", close);
  redis.on("end", end);
  redis.on("reconnecting", reconnecting);
  try {
    if (redis.status === "wait") await redis.connect();
    await redis.ping();
  } catch (error) {
    throw new RedisStartupError(lastFailure ?? sanitizeRedisFailure(error));
  } finally {
    redis.off("error", capture);
    redis.off("connect", connect);
    redis.off("ready", ready);
    redis.off("close", close);
    redis.off("end", end);
    redis.off("reconnecting", reconnecting);
  }
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
