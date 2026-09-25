import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { BlockchainProvider, HistoricalWalletTransaction, WalletAddress } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import { persistNormalizedTransaction, type DbTransaction, type IngestionSource, type PersistedTransaction } from "./transaction-store";

export interface WalletHistoryPageResult {
  readonly nextCursor: string | null;
  readonly completed: boolean;
}

/**
 * Stores one historical transaction. The provider event keeps its own identity namespace (`history:`) while the
 * canonical transaction, flows and trades are shared with live ingestion. History is finalized data.
 */
export async function persistHistoricalTransaction(transaction: DbTransaction, walletId: string, chainTransaction: HistoricalWalletTransaction, source: IngestionSource = "helius-history"): Promise<PersistedTransaction | null> {
  const externalEventId = `history:${walletId}:${chainTransaction.signature}`;
  const payloadHash = createHash("sha256").update(`${chainTransaction.signature}:${String(chainTransaction.slot)}:${String(chainTransaction.succeeded)}`).digest("hex");
  const [event] = await transaction.insert(schema.providerEvents).values({
    provider: "helius", externalEventId, payloadHash, eventType: "HISTORICAL_TRANSACTION", status: "PROCESSED", signature: chainTransaction.signature, slot: chainTransaction.slot, occurredAt: chainTransaction.occurredAt,
    processedAt: new Date(), payloadSummary: { providerType: chainTransaction.providerType, flowCount: chainTransaction.tokenFlows.length, issues: chainTransaction.issues },
  }).onConflictDoNothing({ target: [schema.providerEvents.provider, schema.providerEvents.externalEventId] }).returning();
  if (!event) return null;
  return persistNormalizedTransaction(transaction, { walletId, providerEventId: event.id, chainTransaction, source, finality: "finalized" });
}

export async function ingestWalletHistoryPage(dependencies: { database: Database; provider: BlockchainProvider }, input: { walletId: string; runId: string }): Promise<WalletHistoryPageResult> {
  const [row] = await dependencies.database.query.select({ run: schema.walletIngestionRuns, wallet: schema.trackedWallets, checkpoint: schema.walletIngestionCheckpoints })
    .from(schema.walletIngestionRuns)
    .innerJoin(schema.trackedWallets, eq(schema.walletIngestionRuns.walletId, schema.trackedWallets.id))
    .leftJoin(schema.walletIngestionCheckpoints, eq(schema.walletIngestionCheckpoints.walletId, schema.trackedWallets.id))
    .where(and(eq(schema.walletIngestionRuns.id, input.runId), eq(schema.walletIngestionRuns.walletId, input.walletId))).limit(1);
  if (!row) throw new Error("WALLET_INGESTION_RUN_NOT_FOUND");
  if (row.wallet.status !== "ACTIVE") throw new Error("WALLET_NOT_ACTIVE");
  if (row.run.status === "COMPLETED") return { nextCursor: null, completed: true };

  await dependencies.database.query.update(schema.walletIngestionRuns).set({ status: "RUNNING", startedAt: row.run.startedAt ?? new Date(), heartbeatAt: new Date(), lastErrorCode: null }).where(eq(schema.walletIngestionRuns.id, input.runId));
  const page = await dependencies.provider.getWalletHistory(row.wallet.address as WalletAddress, { ...(row.run.cursor ? { cursor: row.run.cursor } : {}), limit: 100 });
  const completed = page.nextCursor === undefined;

  await dependencies.database.query.transaction(async (transaction) => {
    let stored = 0;
    for (const chainTransaction of page.transactions) {
      const persisted = await persistHistoricalTransaction(transaction, row.wallet.id, chainTransaction);
      if (persisted) stored += 1;
    }
    await transaction.update(schema.walletIngestionRuns).set({
      status: completed ? "COMPLETED" : "RUNNING",
      cursor: page.nextCursor ?? null,
      pagesProcessed: sql`${schema.walletIngestionRuns.pagesProcessed} + 1`,
      transactionsSeen: sql`${schema.walletIngestionRuns.transactionsSeen} + ${page.transactions.length}`,
      transactionsStored: sql`${schema.walletIngestionRuns.transactionsStored} + ${stored}`,
      heartbeatAt: new Date(),
      completedAt: completed ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(schema.walletIngestionRuns.id, input.runId));
    await transaction.insert(schema.walletIngestionCheckpoints).values({ walletId: row.wallet.id, provider: "helius", cursor: page.nextCursor ?? null, completed }).onConflictDoUpdate({ target: schema.walletIngestionCheckpoints.walletId, set: { cursor: page.nextCursor ?? null, completed, updatedAt: new Date() } });
  });
  return { nextCursor: page.nextCursor ?? null, completed };
}
