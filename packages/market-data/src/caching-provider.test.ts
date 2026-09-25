import { describe, expect, it, vi } from "vitest";
import { defined, WRAPPED_SOL_MINT, type HistoricalPriceProvider, type HistoricalPriceRequest, type HistoricalPriceResult } from "@swi/domain";
import { CachingHistoricalPriceProvider, keyId, RoutingHistoricalPriceProvider, type PriceKey, type PriceStore, type StoredPrice } from "./caching-provider.js";

class MemoryStore implements PriceStore {
  readonly rows = new Map<string, StoredPrice>();
  reads = 0;
  getMany(keys: readonly PriceKey[]) {
    this.reads += 1;
    return Promise.resolve(new Map(keys.flatMap((key) => {
      const row = this.rows.get(keyId(key));
      return row ? [[keyId(key), row] as const] : [];
    })));
  }
  putMany(entries: readonly { key: PriceKey; result: StoredPrice["result"] }[]) {
    const out = new Map<string, StoredPrice>();
    for (const { key, result } of entries) {
      if (!this.rows.has(keyId(key))) this.rows.set(keyId(key), { id: `row-${String(this.rows.size + 1)}`, result });
      out.set(keyId(key), defined(this.rows.get(keyId(key))));
    }
    return Promise.resolve(out);
  }
}

const sol = (iso: string): HistoricalPriceRequest => ({ asset: WRAPPED_SOL_MINT, at: new Date(iso) });
const found = (request: HistoricalPriceRequest, price: string) => ({
  status: "FOUND" as const,
  observation: { asset: request.asset, requestedAt: request.at, observedAt: request.at, priceUsd: price, provider: "fake", granularitySeconds: 60, confidenceBps: 9500 },
});
const key = (iso: string): PriceKey => ({ provider: "fake", asset: WRAPPED_SOL_MINT, granularitySeconds: 60, bucketStart: new Date(iso) });

function fakeProvider(answer: (request: HistoricalPriceRequest) => HistoricalPriceResult) {
  const getPrices = vi.fn((requests: readonly HistoricalPriceRequest[]) => Promise.resolve(requests.map(answer)));
  const provider: HistoricalPriceProvider = { name: "fake", granularitySeconds: 60, supports: (asset) => asset === WRAPPED_SOL_MINT, getPrices };
  return { provider, getPrices };
}

describe("CachingHistoricalPriceProvider", () => {
  it("fetches a duplicated request once", async () => {
    const { provider, getPrices } = fakeProvider((request) => found(request, "100"));
    const cache = new CachingHistoricalPriceProvider(provider, new MemoryStore());
    const results = await cache.getPrices([sol("2026-09-01T12:00:05Z"), sol("2026-09-01T12:00:55Z"), sol("2026-09-01T12:00:05Z")]);
    expect(getPrices).toHaveBeenCalledTimes(1);
    expect(getPrices.mock.calls[0]?.[0]).toHaveLength(1);
    expect(results.map((result) => result.status)).toEqual(["FOUND", "FOUND", "FOUND"]);
    // Each caller still sees the time it asked about, and the persisted row id.
    expect(results[1]).toMatchObject({ observation: { requestedAt: new Date("2026-09-01T12:00:55Z"), observationId: "row-1" } });
  });

  it("serves later calls from the durable store without touching the provider, even after a restart", async () => {
    const store = new MemoryStore();
    await new CachingHistoricalPriceProvider(fakeProvider((request) => found(request, "100")).provider, store).getPrices([sol("2026-09-01T12:00:00Z")]);
    const second = fakeProvider(() => {
      throw new Error("must not be called");
    });
    const results = await new CachingHistoricalPriceProvider(second.provider, store).getPrices([sol("2026-09-01T12:00:30Z")]);
    expect(second.getPrices).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: "FOUND", observation: { priceUsd: "100", observationId: "row-1" } });
  });

  it("serves repeated calls from memory", async () => {
    const store = new MemoryStore();
    const { provider, getPrices } = fakeProvider((request) => found(request, "100"));
    const cache = new CachingHistoricalPriceProvider(provider, store);
    await cache.getPrices([sol("2026-09-01T12:00:00Z")]);
    const readsAfterFirst = store.reads;
    await cache.getPrices([sol("2026-09-01T12:00:10Z")]);
    expect(getPrices).toHaveBeenCalledTimes(1);
    expect(store.reads).toBe(readsAfterFirst);
  });

  it("persists a definitive miss so it is not fetched again, but never persists a transient error", async () => {
    const store = new MemoryStore();
    let mode: "missing" | "error" = "missing";
    const { provider, getPrices } = fakeProvider((request) => (mode === "missing"
      ? { status: "NOT_AVAILABLE", asset: request.asset, requestedAt: request.at, provider: "fake", reason: "NO_CANDLE_WITHIN_5_MINUTES" }
      : { status: "ERROR", asset: request.asset, requestedAt: request.at, provider: "fake", reason: "TIMEOUT_OR_NETWORK" }));
    const cache = new CachingHistoricalPriceProvider(provider, store);
    expect((await cache.getPrices([sol("2026-09-01T12:00:00Z")]))[0]?.status).toBe("NOT_AVAILABLE");
    expect((await cache.getPrices([sol("2026-09-01T12:00:00Z")]))[0]?.status).toBe("NOT_AVAILABLE");
    expect(getPrices).toHaveBeenCalledTimes(1);

    mode = "error";
    expect((await cache.getPrices([sol("2026-09-01T13:00:00Z")]))[0]?.status).toBe("ERROR");
    mode = "missing";
    expect((await cache.getPrices([sol("2026-09-01T13:00:00Z")]))[0]?.status).toBe("NOT_AVAILABLE");
    expect(getPrices).toHaveBeenCalledTimes(3);
    expect(store.rows.size).toBe(2);
  });

  it("coalesces identical concurrent requests into one upstream call", async () => {
    const { provider, getPrices } = fakeProvider((request) => found(request, "100"));
    const cache = new CachingHistoricalPriceProvider(provider, new MemoryStore());
    const [a, b] = await Promise.all([cache.getPrices([sol("2026-09-01T12:00:00Z")]), cache.getPrices([sol("2026-09-01T12:00:20Z")])]);
    expect(getPrices).toHaveBeenCalledTimes(1);
    expect(a[0]?.status).toBe("FOUND");
    expect(b[0]?.status).toBe("FOUND");
  });

  it("keeps the first written price so accounting stays reproducible", async () => {
    const store = new MemoryStore();
    store.rows.set(keyId(key("2026-09-01T12:00:00Z")), { id: "row-old", result: found(sol("2026-09-01T12:00:00Z"), "99") });
    const results = await new CachingHistoricalPriceProvider(fakeProvider((request) => found(request, "555")).provider, store).getPrices([sol("2026-09-01T12:00:00Z")]);
    expect(results[0]).toMatchObject({ observation: { priceUsd: "99", observationId: "row-old" } });
  });

  it("turns a provider crash into a transient ERROR", async () => {
    const { provider } = fakeProvider(() => {
      throw new Error("boom");
    });
    const results = await new CachingHistoricalPriceProvider(provider, new MemoryStore()).getPrices([sol("2026-09-01T12:00:00Z")]);
    expect(results[0]).toMatchObject({ status: "ERROR", reason: "PROVIDER_THREW" });
  });
});

describe("RoutingHistoricalPriceProvider", () => {
  it("routes covered assets to their provider and reports the rest as UNSUPPORTED", async () => {
    const { provider, getPrices } = fakeProvider((request) => found(request, "100"));
    const router = new RoutingHistoricalPriceProvider([provider]);
    const results = await router.getPrices([sol("2026-09-01T12:00:00Z"), { asset: "LongTailMint", at: new Date("2026-09-01T12:00:00Z") }]);
    expect(results.map((result) => result.status)).toEqual(["FOUND", "UNSUPPORTED"]);
    expect(getPrices.mock.calls[0]?.[0]).toHaveLength(1);
    expect(router.supports("LongTailMint")).toBe(false);
  });
});
