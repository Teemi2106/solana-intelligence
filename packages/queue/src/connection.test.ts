import { describe, expect, it } from "vitest";
import { createRedisConnection, redisConnectionOptions, sanitizeRedisFailure } from "./connection";

describe("Redis connection profiles", () => {
  it("bounds ordinary command retries and keeps their timeout finite", () => {
    const options = redisConnectionOptions("general");
    expect(options).toMatchObject({
      commandTimeout: 10_000,
      connectTimeout: 10_000,
      keepAlive: 10_000,
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });
    expect(options.retryStrategy?.(12)).toBe(3_000);
    expect(options.retryStrategy?.(13)).toBeNull();
  });

  it("leaves BullMQ blocking commands without an application timeout", () => {
    const options = redisConnectionOptions("bullmq");
    expect(options).toMatchObject({
      connectTimeout: 10_000,
      keepAlive: 10_000,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    expect(options.commandTimeout).toBeUndefined();
    expect(options.retryStrategy?.(13)).toBeNull();
  });

  it("enables TLS from a rediss URL for both connection profiles without custom insecure options", () => {
    for (const purpose of ["general", "bullmq"] as const) {
      const redis = createRedisConnection("rediss://default:secret@example.upstash.io:6379", purpose);
      expect(redis.options).toMatchObject({ host: "example.upstash.io", port: 6379 });
      expect(redis.options.tls).toBe(true);
      redis.disconnect();
    }
  });

  it("classifies root causes without echoing error messages or endpoints", () => {
    const dns = Object.assign(new Error("getaddrinfo ENOTFOUND secret.example"), { code: "ENOTFOUND" });
    const auth = new Error("WRONGPASS invalid username-password pair");
    expect(sanitizeRedisFailure(dns)).toEqual({ category: "dns", code: "ENOTFOUND", errorName: "Error" });
    expect(sanitizeRedisFailure(auth)).toEqual({ category: "authentication", code: "UNKNOWN", errorName: "Error" });
    expect(JSON.stringify(sanitizeRedisFailure(dns))).not.toContain("secret.example");
  });
});
