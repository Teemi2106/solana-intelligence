import { defined, type HistoricalPriceProvider, type HistoricalPriceRequest, type HistoricalPriceResult } from "@swi/domain";

export interface PriceKey {
  readonly provider: string;
  readonly asset: string;
  readonly granularitySeconds: number;
  readonly bucketStart: Date;
}

export type CacheableResult = Extract<HistoricalPriceResult, { status: "FOUND" | "NOT_AVAILABLE" }>;

export interface StoredPrice {
  readonly id: string;
  readonly result: CacheableResult;
}

/** Durable cache of accounting prices. Rows are immutable once written, so reprocessing is deterministic. */
export interface PriceStore {
  getMany(keys: readonly PriceKey[]): Promise<ReadonlyMap<string, StoredPrice>>;
  /** Persists results and returns the authoritative row per key. An existing row wins (first write is authoritative). */
  putMany(entries: readonly { readonly key: PriceKey; readonly result: CacheableResult }[]): Promise<ReadonlyMap<string, StoredPrice>>;
}

export const keyId = (key: PriceKey) => `${key.provider}|${key.asset}|${String(key.granularitySeconds)}|${String(key.bucketStart.getTime())}`;

/**
 * Wraps a provider with (1) request de-duplication inside and across concurrent calls, (2) an in-memory
 * layer, and (3) a durable store. Found prices and definitive misses are cached; transient errors never are,
 * so a timeout is retried on the next run instead of becoming a permanent gap.
 */
export class CachingHistoricalPriceProvider implements HistoricalPriceProvider {
  readonly name: string;
  readonly granularitySeconds: number;
  private readonly memory = new Map<string, StoredPrice>();
  private readonly inFlight = new Map<string, Promise<HistoricalPriceResult>>();
  upstreamRequests = 0;

  constructor(private readonly inner: HistoricalPriceProvider, private readonly store: PriceStore) {
    this.name = inner.name;
    this.granularitySeconds = inner.granularitySeconds;
  }

  supports(asset: string): boolean {
    return this.inner.supports(asset);
  }

  async getPrices(requests: readonly HistoricalPriceRequest[]): Promise<readonly HistoricalPriceResult[]> {
    const keyOf = (request: HistoricalPriceRequest): PriceKey => ({
      provider: this.name, asset: request.asset, granularitySeconds: this.granularitySeconds,
      bucketStart: new Date(Math.floor(request.at.getTime() / (this.granularitySeconds * 1000)) * this.granularitySeconds * 1000),
    });
    const unique = new Map<string, { key: PriceKey; request: HistoricalPriceRequest }>();
    for (const request of requests) {
      const key = keyOf(request);
      if (!unique.has(keyId(key))) unique.set(keyId(key), { key, request });
    }

    const resolved = new Map<string, HistoricalPriceResult>();
    const pending: { key: PriceKey; request: HistoricalPriceRequest; settle: (result: HistoricalPriceResult) => void }[] = [];
    const awaiting: { id: string; promise: Promise<HistoricalPriceResult> }[] = [];
    for (const [id, entry] of unique) {
      const running = this.inFlight.get(id);
      const cached = this.memory.get(id);
      if (running) awaiting.push({ id, promise: running });
      else if (!this.inner.supports(entry.request.asset)) resolved.set(id, { status: "UNSUPPORTED", asset: entry.request.asset, requestedAt: entry.request.at, provider: this.name, reason: "ASSET_NOT_COVERED" });
      else if (cached) resolved.set(id, this.materialize(cached, entry.request));
      else {
        // Registered synchronously, before any await, so concurrent callers share this lookup.
        let settle: (result: HistoricalPriceResult) => void = () => undefined;
        const promise = new Promise<HistoricalPriceResult>((resolve) => {
          settle = resolve;
        });
        this.inFlight.set(id, promise);
        pending.push({ ...entry, settle });
        awaiting.push({ id, promise });
      }
    }
    if (pending.length > 0) await this.resolvePending(pending);
    for (const { id, promise } of awaiting) resolved.set(id, await promise.finally(() => this.inFlight.delete(id)));
    return requests.map((request) => {
      const result = defined(resolved.get(keyId(keyOf(request))));
      // Every caller gets its own requestedAt even though the bucket observation is shared.
      return result.status === "FOUND" ? { status: "FOUND", observation: { ...result.observation, requestedAt: request.at } } : { ...result, requestedAt: request.at };
    });
  }

  private async resolvePending(pending: readonly { key: PriceKey; request: HistoricalPriceRequest; settle: (result: HistoricalPriceResult) => void }[]): Promise<void> {
    const misses: typeof pending[number][] = [];
    try {
      const fromStore = await this.store.getMany(pending.map((entry) => entry.key));
      for (const entry of pending) {
        const hit = fromStore.get(keyId(entry.key));
        if (hit) {
          this.memory.set(keyId(entry.key), hit);
          entry.settle(this.materialize(hit, entry.request));
        } else misses.push(entry);
      }
      if (misses.length > 0) {
        const fetched = await this.fetchAndStore(misses);
        misses.forEach((entry, index) => {
          entry.settle(defined(fetched[index]));
        });
      }
    } catch {
      for (const entry of pending) entry.settle({ status: "ERROR", asset: entry.key.asset, requestedAt: entry.request.at, provider: this.name, reason: "CACHE_FAILURE" });
    }
  }

  private materialize(stored: StoredPrice, request: HistoricalPriceRequest): HistoricalPriceResult {
    return stored.result.status === "FOUND"
      ? { status: "FOUND", observation: { ...stored.result.observation, requestedAt: request.at, observationId: stored.id } }
      : { ...stored.result, requestedAt: request.at };
  }

  private async fetchAndStore(entries: readonly { key: PriceKey; request: HistoricalPriceRequest }[]): Promise<readonly HistoricalPriceResult[]> {
    this.upstreamRequests += 1;
    // One representative request per bucket; the provider batches them into as few upstream calls as it can.
    let results: readonly HistoricalPriceResult[];
    try {
      results = await this.inner.getPrices(entries.map((entry) => ({ asset: entry.key.asset, at: entry.key.bucketStart })));
    } catch {
      return entries.map((entry) => ({ status: "ERROR" as const, asset: entry.key.asset, requestedAt: entry.request.at, provider: this.name, reason: "PROVIDER_THREW" }));
    }
    const cacheable = entries.flatMap((entry, index) => {
      const result = results[index];
      return result && (result.status === "FOUND" || result.status === "NOT_AVAILABLE") ? [{ key: entry.key, result }] : [];
    });
    const stored = cacheable.length > 0 ? await this.store.putMany(cacheable) : new Map<string, StoredPrice>();
    return entries.map((entry, index) => {
      const authoritative = stored.get(keyId(entry.key));
      if (authoritative) {
        this.memory.set(keyId(entry.key), authoritative);
        return this.materialize(authoritative, entry.request);
      }
      return results[index] ?? { status: "ERROR" as const, asset: entry.key.asset, requestedAt: entry.request.at, provider: this.name, reason: "MISSING_RESULT" };
    });
  }
}

/** Routes each request to the first provider that covers the asset; uncovered assets are UNSUPPORTED, never guessed. */
export class RoutingHistoricalPriceProvider implements HistoricalPriceProvider {
  readonly name = "router";
  readonly granularitySeconds = 60;

  constructor(private readonly providers: readonly HistoricalPriceProvider[]) {}

  supports(asset: string): boolean {
    return this.providers.some((provider) => provider.supports(asset));
  }

  async getPrices(requests: readonly HistoricalPriceRequest[]): Promise<readonly HistoricalPriceResult[]> {
    const results = new Array<HistoricalPriceResult>(requests.length);
    for (const provider of this.providers) {
      const indexes = requests.flatMap((request, index) => (results[index] === undefined && provider.supports(request.asset) ? [index] : []));
      if (indexes.length === 0) continue;
      const answered = await provider.getPrices(indexes.map((index) => defined(requests[index])));
      indexes.forEach((index, position) => {
        results[index] = defined(answered[position]);
      });
    }
    return requests.map((request, index) => results[index] ?? { status: "UNSUPPORTED", asset: request.asset, requestedAt: request.at, provider: this.name, reason: "NO_PROVIDER_COVERS_ASSET" });
  }
}
