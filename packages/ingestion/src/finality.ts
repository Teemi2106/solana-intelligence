import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { FinalityProvider } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";

/**
 * Solana finality policy.
 * - Webhook events are delivered when a transaction is *confirmed* (supermajority voted, not yet rooted). They are stored
 *   as `confirmed` and shown live, but do not feed FIFO accounting, performance snapshots, scores or evidence.
 * - A delayed check asks RPC for the signature status. `finalized` promotes the row; a signature that still cannot be found
 *   after DROP_AFTER_MS is treated as `dropped` (its fork was abandoned) and is excluded permanently.
 * - History (finalized) arriving for a confirmed row also promotes it, without creating anything twice.
 */
export const FINALITY_DROP_AFTER_MS = 15 * 60_000;
export const FINALITY_MAX_ATTEMPTS = 40;

export type FinalityCheckResult =
  | { readonly status: "FINALIZED"; readonly walletIds: readonly string[] }
  | { readonly status: "DROPPED"; readonly walletIds: readonly string[] }
  | { readonly status: "PENDING"; readonly walletIds: readonly string[] }
  | { readonly status: "NOTHING_TO_CHECK"; readonly walletIds: readonly string[] };

export async function checkSignatureFinality(dependencies: { database: Database; provider: FinalityProvider; metrics?: MetricsRegistry; now?: () => Date }, signature: string): Promise<FinalityCheckResult> {
  const { database } = dependencies;
  const now = (dependencies.now ?? (() => new Date()))();
  const rows = await database.query.select().from(schema.walletTransactions).where(and(eq(schema.walletTransactions.signature, signature), eq(schema.walletTransactions.finality, "confirmed")));
  if (rows.length === 0) return { status: "NOTHING_TO_CHECK", walletIds: [] };
  const walletIds = rows.map((row) => row.walletId);
  // Network call happens with no transaction open.
  const status = (await dependencies.provider.getFinality([signature])).get(signature) ?? "NOT_FOUND";
  const oldest = Math.min(...rows.map((row) => row.firstSeenAt.getTime()));

  if (status === "FINALIZED") {
    await database.query.update(schema.walletTransactions).set({ finality: "finalized", finalizedAt: now, finalityCheckedAt: now }).where(and(eq(schema.walletTransactions.signature, signature), eq(schema.walletTransactions.finality, "confirmed")));
    dependencies.metrics?.increment("finality_transitions_total", { to: "finalized" });
    return { status: "FINALIZED", walletIds };
  }
  if (status === "FAILED" || (status === "NOT_FOUND" && now.getTime() - oldest >= FINALITY_DROP_AFTER_MS)) {
    await database.query.update(schema.walletTransactions).set({ finality: "dropped", finalityCheckedAt: now }).where(and(eq(schema.walletTransactions.signature, signature), eq(schema.walletTransactions.finality, "confirmed")));
    dependencies.metrics?.increment("finality_transitions_total", { to: "dropped" });
    return { status: "DROPPED", walletIds };
  }
  await database.query.update(schema.walletTransactions).set({ finalityCheckedAt: now }).where(and(eq(schema.walletTransactions.signature, signature), eq(schema.walletTransactions.finality, "confirmed")));
  return { status: "PENDING", walletIds };
}

/** Confirmed signatures whose finality has not been checked recently: recovery for lost finality-check jobs. */
export async function findUncheckedConfirmed(database: Database, options: { now: Date; olderThanMs: number; limit: number }): Promise<readonly string[]> {
  const stale = new Date(options.now.getTime() - options.olderThanMs);
  const rows = await database.query.selectDistinct({ signature: schema.walletTransactions.signature }).from(schema.walletTransactions).where(and(
    eq(schema.walletTransactions.finality, "confirmed"),
    lt(schema.walletTransactions.firstSeenAt, stale),
    or(isNull(schema.walletTransactions.finalityCheckedAt), lt(schema.walletTransactions.finalityCheckedAt, stale)),
  )).limit(options.limit);
  return rows.map((row) => row.signature);
}
