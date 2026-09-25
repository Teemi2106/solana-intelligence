import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_WEBHOOK_BODY_BYTES } from "@swi/blockchain";
import { loadWalletFixtures } from "@swi/blockchain/fixtures";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import { schema } from "@swi/db";
import { handleHeliusWebhook, type WebhookDependencies } from "./webhook-handler";
import { addWallet, MemoryLimiter, newMetrics, recordingLogger, resetDatabase, SECRET, webhookRequest } from "./test-helpers";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());
const fixtures = loadWalletFixtures();

describe.skipIf(!context)("Helius webhook endpoint", () => {
  const database = () => requireDatabase(context);
  let limiter: MemoryLimiter;
  let enqueued: string[][];
  let logs: ReturnType<typeof recordingLogger>;
  let metrics: ReturnType<typeof newMetrics>;
  let enqueue: ReturnType<typeof vi.fn<(ids: readonly string[]) => Promise<void>>>;

  const dependencies = (overrides: Partial<WebhookDependencies> = {}): WebhookDependencies => ({ enabled: true, secret: SECRET, database: database(), enqueue, limiter, metrics, logger: logs.logger, ...overrides });
  const call = (request: Request, overrides: Partial<WebhookDependencies> = {}) => handleHeliusWebhook(request, dependencies(overrides));
  const eventCount = async () => (await database().sql<{ n: number }[]>`select count(*)::int as n from provider_events where event_type = 'LIVE_TRANSACTION'`)[0]?.n;

  beforeEach(async () => {
    await resetDatabase(database());
    limiter = new MemoryLimiter();
    enqueued = [];
    logs = recordingLogger();
    metrics = newMetrics();
    enqueue = vi.fn((ids: readonly string[]) => {
      enqueued.push([...ids]);
      return Promise.resolve();
    });
  });

  it("accepts a valid delivery: persists first, then enqueues, then acknowledges", async () => {
    const response = await call(webhookRequest([fixtures.pumpAmmBuy, fixtures.pumpAmmSell]));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 0 });
    expect(await eventCount()).toBe(2);
    const rows = await database().query.select().from(schema.providerEvents);
    expect(rows.map((row) => row.externalEventId).sort()).toEqual([`helius:live:${fixtures.pumpAmmBuy.signature}`, `helius:live:${fixtures.pumpAmmSell.signature}`].sort());
    expect(rows.every((row) => row.status === "QUEUED" && row.payload !== null)).toBe(true);
    expect(enqueued.flat().sort()).toEqual(rows.map((row) => row.id).sort());
    expect(metrics.counter("webhook_events_total", { result: "accepted" })).toBe(2);
  });

  it("does no heavy work on the request path: nothing but provider events is written", async () => {
    await addWallet(database());
    await call(webhookRequest([fixtures.pumpAmmBuy]));
    const [counts] = await database().sql<{ tx: number; trades: number; prices: number }[]>`select (select count(*) from wallet_transactions)::int as tx, (select count(*) from wallet_trades)::int as trades, (select count(*) from historical_price_points)::int as prices`;
    expect(counts).toEqual({ tx: 0, trades: 0, prices: 0 });
  });

  it("rejects requests with invalid authentication and persists nothing", async () => {
    for (const secret of [null, "wrong".repeat(10)]) {
      const response = await call(webhookRequest([fixtures.pumpAmmBuy], { secret }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized" });
    }
    expect(await eventCount()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("rate limits repeated authentication failures per source", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 23; attempt += 1) statuses.push((await call(webhookRequest([], { secret: "bad".repeat(20) }))).status);
    expect(statuses.slice(0, 20).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("rate limits overall traffic from one source", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await call(webhookRequest([fixtures.pumpAmmBuy]), { limits: { perMinute: 3, authFailuresPerMinute: 20 } })).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("rejects malformed JSON and invalid payloads without leaking details", async () => {
    const malformed = await call(webhookRequest(null, { raw: "{not json" }));
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid payload" });
    for (const body of [{ signature: "x" }, [], [{ ...fixtures.pumpAmmBuy, slot: "abc" }], "text"]) {
      const response = await call(webhookRequest(body));
      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).not.toMatch(/zod|issues|stack|slot/i);
    }
    expect(await eventCount()).toBe(0);
  });

  it("rejects an oversized payload by declared length and by streamed length", async () => {
    const declared = await call(webhookRequest([fixtures.pumpAmmBuy], { headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) } }));
    expect(declared.status).toBe(413);
    const huge = JSON.stringify([{ padding: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 10) }]);
    const streamed = await call(new Request("https://example.com/api/webhooks/helius", { method: "POST", headers: { authorization: `Bearer ${SECRET}`, "x-forwarded-for": "203.0.113.9" }, body: huge, duplex: "half" } as RequestInit));
    expect(streamed.status).toBe(413);
    expect(await eventCount()).toBe(0);
  });

  it("treats a redelivered delivery as duplicates and enqueues nothing new", async () => {
    await call(webhookRequest([fixtures.pumpAmmBuy]));
    enqueue.mockClear();
    const again = await call(webhookRequest([fixtures.pumpAmmBuy]));
    expect(await again.json()).toEqual({ accepted: 0, duplicates: 1 });
    expect(await eventCount()).toBe(1);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("collapses the same transaction delivered twice inside one delivery", async () => {
    const response = await call(webhookRequest([fixtures.pumpAmmBuy, fixtures.pumpAmmBuy, fixtures.pumpAmmSell]));
    expect(await response.json()).toEqual({ accepted: 2, duplicates: 1 });
    expect(await eventCount()).toBe(2);
  });

  it("is safe under concurrent identical deliveries: exactly one event per signature", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, () => call(webhookRequest([fixtures.pumpAmmBuy, fixtures.pumpAmmSell]))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(await eventCount()).toBe(2);
    expect(enqueued.flat()).toHaveLength(2);
  });

  it("still acknowledges when the queue is down, leaving events recoverable by the sweeper", async () => {
    enqueue.mockRejectedValueOnce(new Error("redis unavailable"));
    const response = await call(webhookRequest([fixtures.pumpAmmBuy]));
    expect(response.status).toBe(200);
    const [row] = await database().query.select().from(schema.providerEvents);
    expect(row?.status).toBe("RECEIVED");
    expect(metrics.counter("webhook_enqueue_failures_total")).toBe(1);
  });

  it("fails open on rate limiter outages but still requires authentication", async () => {
    limiter.fail = true;
    expect((await call(webhookRequest([fixtures.pumpAmmBuy]))).status).toBe(200);
    expect((await call(webhookRequest([fixtures.pumpAmmSell], { secret: null }))).status).toBe(401);
  });

  it("asks the provider to retry when nothing could be stored, without internals in the body", async () => {
    const broken = { query: { insert: () => { throw new Error("connection refused at 10.0.0.5:5432"); } } } as unknown as WebhookDependencies["database"];
    const response = await call(webhookRequest([fixtures.pumpAmmBuy]), { database: broken });
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toMatch(/10\.0\.0\.5|connection|stack/);
  });

  it("does not exist when live ingestion is disabled", async () => {
    const response = await call(webhookRequest([fixtures.pumpAmmBuy]), { enabled: false });
    expect(response.status).toBe(404);
    expect(await eventCount()).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("only accepts POST", async () => {
    const response = await call(webhookRequest(null, { method: "PUT", raw: "[]" }));
    expect(response.status).toBe(405);
  });

  it("never logs the secret, the authorization header or payload bodies", async () => {
    await call(webhookRequest([fixtures.pumpAmmBuy]));
    await call(webhookRequest([fixtures.pumpAmmBuy], { secret: "leaky-secret-value-1234567890" }));
    await call(webhookRequest(null, { raw: "{bad" }));
    const output = logs.lines.join("\n");
    expect(output).not.toContain(SECRET);
    expect(output).not.toContain("leaky-secret-value");
    expect(output).not.toMatch(/authorization|bearer/i);
    expect(output).not.toContain(fixtures.pumpAmmBuy.signature);
  });
});
