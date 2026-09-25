import { describe, expect, it } from "vitest";
import { redisConnectionOptions } from "./connection";

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
  });
});
