import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "./client";
import { auditLogs, trackedWallets, walletClassifications, walletIngestionRuns, walletLabels, walletPerformanceSnapshots, walletPositions, walletScores, walletScoreVersions, walletTrades, tokens } from "./schema/index";

export type WalletStatus = "ACTIVE" | "PAUSED" | "ARCHIVED";

export async function createTrackedWallet(database: Database, input: { address: string; displayName?: string; labels: readonly string[]; actorId: string; requestId: string }) {
  return database.query.transaction(async (transaction) => {
    const [wallet] = await transaction.insert(trackedWallets).values({ address: input.address, displayName: input.displayName }).onConflictDoNothing({ target: trackedWallets.address }).returning();
    const existing = wallet ?? (await transaction.select().from(trackedWallets).where(eq(trackedWallets.address, input.address)).limit(1))[0];
    if (!existing) throw new Error("wallet could not be created");
    if (input.labels.length > 0) await transaction.insert(walletLabels).values(input.labels.map((label) => ({ walletId: existing.id, label, source: "OPERATOR" }))).onConflictDoNothing();
    await transaction.insert(auditLogs).values({ actorId: input.actorId, action: "wallet.create", targetType: "tracked_wallet", targetId: existing.id, requestId: input.requestId, after: { address: input.address, displayName: input.displayName ?? null, labels: input.labels } });
    return existing;
  });
}

export async function setTrackedWalletStatus(database: Database, input: { walletId: string; status: WalletStatus; actorId: string; requestId: string }) {
  return database.query.transaction(async (transaction) => {
    const [before] = await transaction.select().from(trackedWallets).where(eq(trackedWallets.id, input.walletId)).limit(1);
    if (!before) return null;
    const [updated] = await transaction.update(trackedWallets).set({ status: input.status, updatedAt: new Date() }).where(eq(trackedWallets.id, input.walletId)).returning();
    await transaction.insert(auditLogs).values({ actorId: input.actorId, action: "wallet.status.update", targetType: "tracked_wallet", targetId: input.walletId, requestId: input.requestId, before: { status: before.status }, after: { status: input.status } });
    return updated ?? null;
  });
}

export async function startWalletIngestion(database: Database, walletId: string, idempotencyKey: string) {
  const [created] = await database.query.insert(walletIngestionRuns).values({ walletId, idempotencyKey }).onConflictDoNothing({ target: walletIngestionRuns.idempotencyKey }).returning();
  return created ?? (await database.query.select().from(walletIngestionRuns).where(eq(walletIngestionRuns.idempotencyKey, idempotencyKey)).limit(1))[0] ?? null;
}

export async function listTrackedWallets(database: Database) {
  const wallets = await database.query.select().from(trackedWallets).orderBy(desc(trackedWallets.createdAt));
  if (wallets.length === 0) return [];
  const ids = wallets.map((wallet) => wallet.id);
  const [labels, runs, scores, classifications] = await Promise.all([
    database.query.select().from(walletLabels).where(inArray(walletLabels.walletId, ids)),
    database.query.select().from(walletIngestionRuns).where(inArray(walletIngestionRuns.walletId, ids)).orderBy(desc(walletIngestionRuns.createdAt)),
    database.query.select().from(walletScores).where(inArray(walletScores.walletId, ids)).orderBy(desc(walletScores.validFrom)),
    database.query.select().from(walletClassifications).where(inArray(walletClassifications.walletId, ids)).orderBy(desc(walletClassifications.validFrom)),
  ]);
  return wallets.map((wallet) => ({
    ...wallet,
    labels: labels.filter((label) => label.walletId === wallet.id),
    ingestion: runs.find((run) => run.walletId === wallet.id) ?? null,
    score: scores.find((score) => score.walletId === wallet.id && score.validTo === null) ?? null,
    classification: classifications.find((item) => item.walletId === wallet.id && item.validTo === null) ?? null,
  }));
}

export async function getWalletDetail(database: Database, address: string) {
  const [wallet] = await database.query.select().from(trackedWallets).where(eq(trackedWallets.address, address)).limit(1);
  if (!wallet) return null;
  const [labels, runs, performance, scores, classifications, trades, positions, diagnosticRows, rejectionRows] = await Promise.all([
    database.query.select().from(walletLabels).where(eq(walletLabels.walletId, wallet.id)),
    database.query.select().from(walletIngestionRuns).where(eq(walletIngestionRuns.walletId, wallet.id)).orderBy(desc(walletIngestionRuns.createdAt)).limit(10),
    database.query.select().from(walletPerformanceSnapshots).where(eq(walletPerformanceSnapshots.walletId, wallet.id)).orderBy(desc(walletPerformanceSnapshots.observedAt)).limit(60),
    database.query.select({ score: walletScores, version: walletScoreVersions.version }).from(walletScores).innerJoin(walletScoreVersions, eq(walletScores.scoreVersionId, walletScoreVersions.id)).where(eq(walletScores.walletId, wallet.id)).orderBy(desc(walletScores.validFrom)).limit(20),
    database.query.select().from(walletClassifications).where(eq(walletClassifications.walletId, wallet.id)).orderBy(desc(walletClassifications.validFrom)).limit(20),
    database.query.select({ trade: walletTrades, token: tokens }).from(walletTrades).innerJoin(tokens, eq(walletTrades.tokenId, tokens.id)).where(eq(walletTrades.walletId, wallet.id)).orderBy(desc(walletTrades.occurredAt)).limit(100),
    database.query.select({ position: walletPositions, token: tokens }).from(walletPositions).innerJoin(tokens, eq(walletPositions.tokenId, tokens.id)).where(and(eq(walletPositions.walletId, wallet.id))),
    database.sql<{
      transactions_ingested: string;
      successful: string;
      failed: string;
      token_flow_transactions: string;
      token_flows: string;
      sol_balance_changes: string;
      provider_swap_candidates: string;
      reconstructed_trades: string;
      priced_trades: string;
      rejected_candidates: string;
    }[]>`
      select
        count(distinct wt.id)::text as transactions_ingested,
        count(distinct wt.id) filter (where wt.succeeded)::text as successful,
        count(distinct wt.id) filter (where not wt.succeeded)::text as failed,
        count(distinct wt.id) filter (where tf.id is not null)::text as token_flow_transactions,
        count(distinct tf.id)::text as token_flows,
        count(distinct wt.id) filter (where (wt.normalized_payload->>'nativeSolDeltaLamports')::numeric <> 0)::text as sol_balance_changes,
        count(distinct wt.id) filter (where wt.normalized_payload->>'providerType' = 'SWAP')::text as provider_swap_candidates,
        count(distinct tr.id)::text as reconstructed_trades,
        count(distinct tr.id) filter (where tr.execution_price_usd is not null)::text as priced_trades,
        count(distinct wt.id) filter (where wt.normalized_payload->>'providerType' = 'SWAP' and tr.id is null)::text as rejected_candidates
      from wallet_transactions wt
      left join transaction_token_flows tf on tf.transaction_id = wt.id
      left join wallet_trades tr on tr.transaction_id = wt.id
      where wt.wallet_id = ${wallet.id}
    `,
    database.sql<{ reason: string; count: string }[]>`
      select issue.value as reason, count(distinct wt.id)::text as count
      from wallet_transactions wt
      cross join lateral jsonb_array_elements_text(coalesce(wt.normalized_payload->'issues', '[]'::jsonb)) issue(value)
      where wt.wallet_id = ${wallet.id} and wt.normalized_payload->>'providerType' = 'SWAP'
      group by issue.value
      order by count(distinct wt.id) desc, issue.value
    `,
  ]);
  const row = diagnosticRows[0];
  const diagnostics = row ? {
    transactionsIngested: Number(row.transactions_ingested),
    successful: Number(row.successful),
    failed: Number(row.failed),
    tokenFlowTransactions: Number(row.token_flow_transactions),
    tokenFlows: Number(row.token_flows),
    solBalanceChanges: Number(row.sol_balance_changes),
    providerSwapCandidates: Number(row.provider_swap_candidates),
    reconstructedTrades: Number(row.reconstructed_trades),
    pricedTrades: Number(row.priced_trades),
    rejectedCandidates: Number(row.rejected_candidates),
    rejectionReasons: rejectionRows.map((reason) => ({ reason: reason.reason, count: Number(reason.count) })),
  } : null;
  // Snapshots are append-only and ordered newest first, so the first row per window is the current one.
  const newest = new Map<number, (typeof performance)[number]>();
  for (const snapshot of performance) if (!newest.has(snapshot.windowDays)) newest.set(snapshot.windowDays, snapshot);
  const latestPerWindow = [...newest.values()].sort((a, b) => a.windowDays - b.windowDays);
  return { wallet, labels, runs, performance: latestPerWindow, scores, classifications, trades, positions, diagnostics };
}
