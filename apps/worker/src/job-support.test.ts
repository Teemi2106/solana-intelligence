import type { Job } from "bullmq";
import { afterAll, describe, expect, it } from "vitest";
import { schema } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import {
  JobTimeoutError,
  recordJobFailure,
  redisCommandName,
  withTimeout,
} from "./job-support.js";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());

describe("withTimeout", () => {
  it("returns the result when work finishes in time", async () => {
    expect(await withTimeout(Promise.resolve(42), 100, "X")).toBe(42);
  });
  it("rejects with a typed error when work overruns", async () => {
    await expect(
      withTimeout(new Promise<never>(() => undefined), 20, "SLOW"),
    ).rejects.toBeInstanceOf(JobTimeoutError);
    await expect(
      withTimeout(new Promise<never>(() => undefined), 20, "SLOW"),
    ).rejects.toThrow("SLOW_TIMEOUT");
  });
  it("propagates the work's own failure", async () => {
    await expect(
      withTimeout(Promise.reject(new Error("boom")), 100, "X"),
    ).rejects.toThrow("boom");
  });
});

describe("Redis failure metadata", () => {
  it("extracts only the command name from a BullMQ timeout", () => {
    const error = Object.assign(new Error("Command timed out"), {
      command: { name: "EVALSHA", args: ["sensitive-payload"] },
    });
    expect(redisCommandName(error)).toBe("EVALSHA");
    expect(redisCommandName(new Error("other failure"))).toBe("unknown");
  });
});

describe.skipIf(!context)("dead-letter recording", () => {
  const database = () => requireDatabase(context);
  const job = (
    attemptsMade: number,
    attempts: number,
    data: Record<string, unknown> = {},
  ) =>
    ({
      id: "live-normalize-abc",
      name: "normalize-live-event",
      data,
      attemptsMade,
      opts: { attempts },
    }) as unknown as Job;

  it("records nothing while retries remain", async () => {
    await database().sql`truncate processing_failures, provider_events cascade`;
    await recordJobFailure(
      database(),
      "transaction-ingestion",
      job(3, 8),
      new Error("temporary"),
    );
    expect(
      await database().query.select().from(schema.processingFailures),
    ).toEqual([]);
  });

  it("records a permanently failed job with safe context only, and marks the provider event failed", async () => {
    await database().sql`truncate processing_failures, provider_events cascade`;
    const [event] = await database()
      .query.insert(schema.providerEvents)
      .values({
        provider: "helius",
        externalEventId: "helius:live:x",
        payloadHash: "h",
        eventType: "LIVE_TRANSACTION",
        payloadSummary: {},
        payload: { secret: "do-not-copy" },
      })
      .returning();
    const error = Object.assign(
      new Error("Helius RPC is temporarily unavailable"),
      { name: "ProviderRequestError" },
    );
    await recordJobFailure(
      database(),
      "transaction-ingestion",
      job(8, 8, { providerEventId: event?.id, giant: "x".repeat(10_000) }),
      error,
    );
    await recordJobFailure(
      database(),
      "transaction-ingestion",
      job(8, 8, { providerEventId: event?.id }),
      error,
    );
    const failures = await database()
      .query.select()
      .from(schema.processingFailures);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      queue: "transaction-ingestion",
      jobId: "live-normalize-abc",
      errorCode: "ProviderRequestError",
      attemptCount: 8,
      providerEventId: event?.id,
    });
    expect(JSON.stringify(failures[0]?.safeContext)).not.toContain(
      "do-not-copy",
    );
    expect(JSON.stringify(failures[0]?.safeContext)).not.toContain("xxxx");
    expect(
      (await database().query.select().from(schema.providerEvents))[0],
    ).toMatchObject({
      status: "FAILED",
      lastErrorCode: "ProviderRequestError",
    });
  });
});
