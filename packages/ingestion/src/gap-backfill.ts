import { and, desc, eq, inArray } from "drizzle-orm";
import type { BlockchainProvider, WalletAddress } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";
import { persistHistoricalTransaction } from "./historical";

export interface GapBackfillResult {
  readonly status: "COMPLETED" | "SKIPPED_HISTORY_INCOMPLETE" | "SKIPPED_WALLET_INACTIVE" | "PAGE_LIMIT_REACHED";
  readonly pages: number;
  readonly transactionsSeen: number;
  readonly transactionsCreated: number;
}

/**
 * Recovers transactions a webhook never delivered (Helius drops an event after three failed attempts, and nothing is
 * delivered while a wallet is unsubscribed or the system is down). Pages newest-first through history and stops after the
 * page in which it meets a signature it already holds. Everything goes through the idempotent transaction store.
 */
export async function backfillWalletGap(dependencies: { database: Database; provider: BlockchainProvider; metrics?: MetricsRegistry; now?: () => Date }, walletId: string, options: { maxPages?: number } = {}): Promise<GapBackfillResult> {
  const { database } = dependencies;
  const maxPages = options.maxPages ?? 20;
  const [wallet] = await database.query.select().from(schema.trackedWallets).where(eq(schema.trackedWallets.id, walletId)).limit(1);
  if (wallet?.status !== "ACTIVE") return { status: "SKIPPED_WALLET_INACTIVE", pages: 0, transactionsSeen: 0, transactionsCreated: 0 };
  const [latestRun] = await database.query.select().from(schema.walletIngestionRuns).where(eq(schema.walletIngestionRuns.walletId, walletId)).orderBy(desc(schema.walletIngestionRuns.createdAt)).limit(1);
  // Initial history still running: it will cover the gap itself, and racing it only wastes provider calls.
  if (latestRun?.status !== "COMPLETED") return { status: "SKIPPED_HISTORY_INCOMPLETE", pages: 0, transactionsSeen: 0, transactionsCreated: 0 };

  let cursor: string | undefined;
  let pages = 0;
  let seen = 0;
  let created = 0;
  for (; pages < maxPages;) {
    const page = await dependencies.provider.getWalletHistory(wallet.address as WalletAddress, { ...(cursor ? { cursor } : {}), limit: 100 });
    pages += 1;
    seen += page.transactions.length;
    const signatures = page.transactions.map((transaction) => transaction.signature);
    const known = signatures.length === 0 ? [] : await database.query.select({ signature: schema.walletTransactions.signature }).from(schema.walletTransactions).where(and(eq(schema.walletTransactions.walletId, walletId), inArray(schema.walletTransactions.signature, signatures)));
    const knownSet = new Set(known.map((row) => row.signature));
    await database.query.transaction(async (transaction) => {
      for (const chainTransaction of page.transactions) {
        if (knownSet.has(chainTransaction.signature)) {
          // Already stored (possibly as confirmed): history is finalized, so this also promotes it.
          await persistHistoricalTransaction(transaction, walletId, chainTransaction, "helius-gap-backfill");
          continue;
        }
        const persisted = await persistHistoricalTransaction(transaction, walletId, chainTransaction, "helius-gap-backfill");
        if (persisted?.created) created += 1;
      }
    });
    if (knownSet.size > 0 || page.nextCursor === undefined) {
      await recordBackfill(database, walletId, "COMPLETED", dependencies.now);
      dependencies.metrics?.increment("gap_backfill_total", { status: "completed" });
      return { status: "COMPLETED", pages, transactionsSeen: seen, transactionsCreated: created };
    }
    cursor = page.nextCursor;
  }
  await recordBackfill(database, walletId, "PAGE_LIMIT_REACHED", dependencies.now);
  dependencies.metrics?.increment("gap_backfill_total", { status: "page_limit" });
  return { status: "PAGE_LIMIT_REACHED", pages, transactionsSeen: seen, transactionsCreated: created };
}

async function recordBackfill(database: Database, walletId: string, status: string, now: (() => Date) | undefined): Promise<void> {
  const at = (now ?? (() => new Date()))();
  await database.query.insert(schema.walletLiveMonitoring).values({ walletId, lastBackfillAt: at, lastBackfillStatus: status })
    .onConflictDoUpdate({ target: schema.walletLiveMonitoring.walletId, set: { lastBackfillAt: at, lastBackfillStatus: status, updatedAt: at } });
}
