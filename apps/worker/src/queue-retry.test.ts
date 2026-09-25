import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { defined } from "@swi/domain";
import { normalizeJobOptions } from "@swi/queue";

/** Real BullMQ + Redis behaviour (retry, backoff, deterministic-id dedupe). Skipped when no Redis is reachable. */
async function connect(): Promise<Redis | null> {
  const redis = new Redis(process.env["TEST_REDIS_URL"] ?? "redis://127.0.0.1:6379", { maxRetriesPerRequest: null, lazyConnect: true, connectTimeout: 1_500, retryStrategy: () => null });
  redis.on("error", () => undefined);
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch {
    redis.disconnect();
    return null;
  }
}

const redis = await connect();
afterAll(async () => {
  await redis?.quit().catch(() => undefined);
});

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

describe.skipIf(!redis)("BullMQ job behaviour", () => {
  const connection = () => defined(redis);
  const names: string[] = [];
  const makeQueue = () => {
    const name = `test-${randomUUID()}`;
    names.push(name);
    return { name, queue: new Queue(name, { connection: connection() }) };
  };
  afterAll(async () => {
    for (const name of names) await new Queue(name, { connection: connection() }).obliterate({ force: true }).catch(() => undefined);
  });

  it("retries a failing job with backoff until it succeeds, then stops", async () => {
    const { name, queue } = makeQueue();
    let executions = 0;
    const worker = new Worker(name, () => {
      executions += 1;
      if (executions < 3) throw new Error("transient provider failure");
      return Promise.resolve();
    }, { connection: connection() });
    await queue.add("normalize-live-event", { providerEventId: "x" }, { ...normalizeJobOptions, backoff: { type: "fixed", delay: 20 }, jobId: "live-normalize-retry" });
    await waitFor(() => executions >= 3);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(executions).toBe(3);
    expect(await queue.getJobCounts("failed", "completed")).toMatchObject({ failed: 0, completed: 1 });
    await worker.close();
    await queue.close();
  });

  it("gives up after the bounded attempts and reports the exhausted job for dead-lettering", async () => {
    const { name, queue } = makeQueue();
    const exhausted: { attemptsMade: number; attempts: number | undefined }[] = [];
    const worker = new Worker(name, () => Promise.reject(new Error("always fails")), { connection: connection() });
    worker.on("failed", (job) => { if (job) exhausted.push({ attemptsMade: job.attemptsMade, attempts: job.opts.attempts }); });
    await queue.add("finality-check", {}, { attempts: 3, backoff: { type: "fixed", delay: 10 }, jobId: "bounded" });
    await waitFor(() => exhausted.some((entry) => entry.attemptsMade >= 3));
    expect(exhausted.map((entry) => entry.attemptsMade)).toEqual([1, 2, 3]);
    expect(exhausted.at(-1)?.attempts).toBe(3);
    await worker.close();
    await queue.close();
  });

  it("ignores a second job with the same deterministic id, so duplicate enqueues run once", async () => {
    const { name, queue } = makeQueue();
    let executions = 0;
    const first = await queue.add("normalize-live-event", { n: 1 }, { jobId: "live-normalize-dup" });
    const second = await queue.add("normalize-live-event", { n: 2 }, { jobId: "live-normalize-dup" });
    expect(second.id).toBe(first.id);
    const worker = new Worker(name, () => { executions += 1; return Promise.resolve(); }, { connection: connection() });
    await waitFor(() => executions >= 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(executions).toBe(1);
    await worker.close();
    await queue.close();
  });

  it("runs at most the configured concurrency", async () => {
    const { name, queue } = makeQueue();
    let active = 0;
    let peak = 0;
    let done = 0;
    const worker = new Worker(name, async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      done += 1;
    }, { connection: connection(), concurrency: 2 });
    await queue.addBulk(Array.from({ length: 6 }, (_, index) => ({ name: "j", data: {}, opts: { jobId: `c-${String(index)}` } })));
    await waitFor(() => done === 6);
    expect(peak).toBe(2);
    await worker.close();
    await queue.close();
  });
});
