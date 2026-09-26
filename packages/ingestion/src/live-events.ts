import { and, eq, inArray, lt, ne, or, sql } from "drizzle-orm";
import { heliusLiveEventId, heliusTransaction, involvedAddresses, normalizeHeliusTransaction, payloadHash, type HeliusTransaction } from "@swi/blockchain";
import type { WalletAddress } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";
import { persistNormalizedTransaction } from "./transaction-store";

export interface RecordedEvents {
  /** Newly persisted events, in payload order. */
  readonly accepted: readonly { readonly id: string; readonly signature: string }[];
  /** Deliveries whose signature was already persisted (provider retry, duplicate, redelivery after restart). */
  readonly duplicates: number;
}

/**
 * Persists validated deliveries as provider events. This is the only database work on the webhook request path:
 * one batched insert, deduplicated by the (provider, external_event_id) unique constraint.
 */
export async function recordLiveEvents(database: Database, transactions: readonly HeliusTransaction[]): Promise<RecordedEvents> {
  const unique = new Map<string, HeliusTransaction>();
  for (const transaction of transactions) if (!unique.has(transaction.signature)) unique.set(transaction.signature, transaction);
  const values = [...unique.values()].map((transaction) => ({
    provider: "helius", externalEventId: heliusLiveEventId(transaction.signature), payloadHash: payloadHash(transaction), eventType: "LIVE_TRANSACTION", status: "RECEIVED" as const,
    signature: transaction.signature, slot: BigInt(transaction.slot), occurredAt: new Date(transaction.timestamp * 1000),
    payloadSummary: { providerType: transaction.type, source: transaction.source ?? null },
    payload: transaction,
  }));
  if (values.length === 0) return { accepted: [], duplicates: 0 };
  const inserted = await database.query.insert(schema.providerEvents).values(values)
    .onConflictDoNothing({ target: [schema.providerEvents.provider, schema.providerEvents.externalEventId] })
    .returning({ id: schema.providerEvents.id, signature: schema.providerEvents.signature });
  const accepted = inserted.flatMap((row) => (row.signature ? [{ id: row.id, signature: row.signature }] : []));
  // Duplicates include repeats inside one delivery as well as signatures persisted earlier.
  return { accepted, duplicates: transactions.length - accepted.length };
}

export interface NormalizeLiveEventResult {
  readonly outcome: "PROCESSED" | "ALREADY_PROCESSED" | "NOT_FOUND" | "INVALID_PAYLOAD" | "NO_TRACKED_WALLET";
  /** Wallets that gained at least one new transaction (need finality tracking / recompute). */
  readonly affected: readonly { readonly walletId: string; readonly walletAddress: string; readonly signature: string; readonly transactionType: string; readonly occurredAt: Date; readonly tradesCreated: number; readonly created: boolean }[];
}

/**
 * Turns a persisted live event into canonical transactions/trades for every tracked wallet it concerns.
 * Safe to run twice, concurrently, or after the same transaction arrived through history: all writes are conflict-safe.
 * Makes no network calls.
 */
export async function normalizeLiveEvent(dependencies: { database: Database; metrics?: MetricsRegistry; now?: () => Date }, providerEventId: string): Promise<NormalizeLiveEventResult> {
  const { database } = dependencies;
  const [event] = await database.query.select().from(schema.providerEvents).where(eq(schema.providerEvents.id, providerEventId)).limit(1);
  if (!event) return { outcome: "NOT_FOUND", affected: [] };
  if (event.status === "PROCESSED") return { outcome: "ALREADY_PROCESSED", affected: [] };
  await database.query.update(schema.providerEvents).set({ status: "PROCESSING", attemptCount: sql`${schema.providerEvents.attemptCount} + 1` }).where(and(eq(schema.providerEvents.id, providerEventId), ne(schema.providerEvents.status, "PROCESSED")));

  const parsed = heliusTransaction.safeParse(event.payload);
  if (!parsed.success) {
    // A stored payload that no longer validates can never succeed; record it instead of retrying forever.
    await database.query.update(schema.providerEvents).set({ status: "FAILED", lastErrorCode: "PAYLOAD_INVALID", processedAt: new Date() }).where(eq(schema.providerEvents.id, providerEventId));
    dependencies.metrics?.increment("live_normalization_total", { outcome: "invalid_payload" });
    return { outcome: "INVALID_PAYLOAD", affected: [] };
  }
  const tx = parsed.data;
  const addresses = [...involvedAddresses(tx)].slice(0, 2_000);
  const wallets = await database.query.select({ id: schema.trackedWallets.id, address: schema.trackedWallets.address }).from(schema.trackedWallets)
    .where(and(inArray(schema.trackedWallets.address, addresses), eq(schema.trackedWallets.status, "ACTIVE")));

  const affected: { walletId: string; walletAddress: string; signature: string; transactionType: string; occurredAt: Date; tradesCreated: number; created: boolean }[] = [];
  for (const wallet of wallets) {
    const chainTransaction = normalizeHeliusTransaction(wallet.address as WalletAddress, tx);
    const persisted = await database.query.transaction(async (transaction) => {
      const result = await persistNormalizedTransaction(transaction, { walletId: wallet.id, providerEventId: event.id, chainTransaction, source: "helius-webhook", finality: "confirmed" });
      await transaction.insert(schema.walletLiveMonitoring).values({ walletId: wallet.id, lastEventAt: chainTransaction.occurredAt, lastSignature: chainTransaction.signature, lastSlot: chainTransaction.slot })
        .onConflictDoUpdate({ target: schema.walletLiveMonitoring.walletId, set: { lastEventAt: sql`greatest(${schema.walletLiveMonitoring.lastEventAt}, excluded.last_event_at)`, lastSignature: sql`case when ${schema.walletLiveMonitoring.lastSlot} is null or excluded.last_slot >= ${schema.walletLiveMonitoring.lastSlot} then excluded.last_signature else ${schema.walletLiveMonitoring.lastSignature} end`, lastSlot: sql`greatest(${schema.walletLiveMonitoring.lastSlot}, excluded.last_slot)`, updatedAt: new Date() } });
      return result;
    });
    affected.push({ walletId: wallet.id, walletAddress: wallet.address, signature: tx.signature, transactionType: tx.type, occurredAt: chainTransaction.occurredAt, tradesCreated: persisted.tradesCreated, created: persisted.created });
    dependencies.metrics?.increment("live_normalization_total", { outcome: persisted.created ? "created" : "existing", kind: persisted.kind });
    if (persisted.tradesCreated > 0) dependencies.metrics?.increment("live_trades_reconstructed_total", {}, persisted.tradesCreated);
  }
  const now = (dependencies.now ?? (() => new Date()))();
  await database.query.update(schema.providerEvents).set({
    status: "PROCESSED", processedAt: now, lastErrorCode: null,
    payloadSummary: { ...event.payloadSummary, outcome: wallets.length === 0 ? "NO_TRACKED_WALLET" : "PROCESSED", wallets: wallets.length, created: affected.filter((item) => item.created).length, existing: affected.filter((item) => !item.created).length },
  }).where(eq(schema.providerEvents.id, providerEventId));
  dependencies.metrics?.observe("live_processing_latency_ms", now.getTime() - event.receivedAt.getTime());
  return { outcome: wallets.length === 0 ? "NO_TRACKED_WALLET" : "PROCESSED", affected };
}

/** Marks events as queued after a successful enqueue (informational; the sweeper does not depend on it). */
export async function markEventsQueued(database: Database, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await database.query.update(schema.providerEvents).set({ status: "QUEUED" }).where(and(inArray(schema.providerEvents.id, [...ids]), eq(schema.providerEvents.status, "RECEIVED")));
}

/**
 * Crash recovery: events that were persisted but never (or not successfully) processed are found here and re-enqueued.
 * Deterministic job ids make re-enqueueing harmless.
 */
export async function findStuckEvents(database: Database, options: { now: Date; olderThanMs: number; processingTimeoutMs: number; limit: number }): Promise<readonly string[]> {
  const stale = new Date(options.now.getTime() - options.olderThanMs);
  const processingStale = new Date(options.now.getTime() - options.processingTimeoutMs);
  const rows = await database.query.select({ id: schema.providerEvents.id }).from(schema.providerEvents).where(and(
    eq(schema.providerEvents.eventType, "LIVE_TRANSACTION"),
    or(
      and(inArray(schema.providerEvents.status, ["RECEIVED", "QUEUED"]), lt(schema.providerEvents.receivedAt, stale)),
      and(eq(schema.providerEvents.status, "PROCESSING"), lt(schema.providerEvents.receivedAt, processingStale)),
    ),
  )).orderBy(schema.providerEvents.receivedAt).limit(options.limit);
  return rows.map((row) => row.id);
}
