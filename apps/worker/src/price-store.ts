import { and, eq, inArray } from "drizzle-orm";
import { Decimal } from "decimal.js";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import { keyId, type CacheableResult, type PriceKey, type PriceStore, type StoredPrice } from "@swi/market-data";

/** PostgreSQL-backed durable price cache. `historical_price_points` rows are the prices accounting actually used. */
export class PostgresPriceStore implements PriceStore {
  constructor(private readonly database: Database) {}

  async getMany(keys: readonly PriceKey[]): Promise<ReadonlyMap<string, StoredPrice>> {
    const found = new Map<string, StoredPrice>();
    const groups = new Map<string, PriceKey[]>();
    for (const key of keys) groups.set(`${key.provider}|${key.asset}|${String(key.granularitySeconds)}`, [...(groups.get(`${key.provider}|${key.asset}|${String(key.granularitySeconds)}`) ?? []), key]);
    for (const group of groups.values()) {
      const [first] = group;
      if (!first) continue;
      const rows = await this.database.query.select().from(schema.historicalPricePoints).where(and(
        eq(schema.historicalPricePoints.provider, first.provider),
        eq(schema.historicalPricePoints.assetMint, first.asset),
        eq(schema.historicalPricePoints.granularitySeconds, first.granularitySeconds),
        inArray(schema.historicalPricePoints.bucketStart, group.map((key) => key.bucketStart)),
      ));
      for (const row of rows) {
        const key: PriceKey = { provider: row.provider, asset: row.assetMint, granularitySeconds: row.granularitySeconds, bucketStart: row.bucketStart };
        const result: CacheableResult = row.status === "FOUND" && row.priceUsd !== null && row.observedAt !== null
          ? { status: "FOUND", observation: { asset: row.assetMint, requestedAt: row.bucketStart, observedAt: row.observedAt, priceUsd: new Decimal(row.priceUsd).toFixed(), provider: row.provider, granularitySeconds: row.granularitySeconds, confidenceBps: row.confidenceBps ?? 0, observationId: row.id } }
          : { status: "NOT_AVAILABLE", asset: row.assetMint, requestedAt: row.bucketStart, provider: row.provider, reason: row.reason ?? "NOT_AVAILABLE" };
        found.set(keyId(key), { id: row.id, result });
      }
    }
    return found;
  }

  async putMany(entries: readonly { readonly key: PriceKey; readonly result: CacheableResult }[]): Promise<ReadonlyMap<string, StoredPrice>> {
    if (entries.length === 0) return new Map();
    await this.database.query.insert(schema.historicalPricePoints).values(entries.map(({ key, result }) => ({
      provider: key.provider, assetMint: key.asset, granularitySeconds: key.granularitySeconds, bucketStart: key.bucketStart,
      status: result.status === "FOUND" ? "FOUND" as const : "NOT_AVAILABLE" as const,
      priceUsd: result.status === "FOUND" ? result.observation.priceUsd : null,
      observedAt: result.status === "FOUND" ? result.observation.observedAt : null,
      confidenceBps: result.status === "FOUND" ? result.observation.confidenceBps : null,
      reason: result.status === "FOUND" ? null : result.reason,
    }))).onConflictDoNothing();
    // A row written earlier wins, so the id (and price) accounting references never changes.
    return this.getMany(entries.map((entry) => entry.key));
  }
}
