import { and, eq } from "drizzle-orm";
import { reconstructSwap, type HistoricalWalletTransaction } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";

export type DbTransaction = Parameters<Parameters<Database["query"]["transaction"]>[0]>[0];

export type Finality = "confirmed" | "finalized" | "dropped";
export type IngestionSource = "helius-history" | "helius-webhook" | "helius-gap-backfill";

export interface PersistedTransaction {
  /** True when this call created the canonical transaction row; false when it already existed (duplicate, or seen via the other path). */
  readonly created: boolean;
  readonly transactionId: string;
  readonly finality: Finality;
  readonly tradesCreated: number;
  readonly kind: string;
}

/**
 * The single place a normalized wallet transaction becomes canonical rows. Historical, gap-backfill and webhook
 * ingestion all go through it, so the same signature always yields the same transaction, flows and trades.
 *
 * Idempotency is enforced by database constraints (wallet_transactions identity, flow identity, trade identity)
 * and ON CONFLICT clauses, never by process-local state, so concurrent workers and replays converge.
 */
export async function persistNormalizedTransaction(
  transaction: DbTransaction,
  input: { walletId: string; providerEventId: string; chainTransaction: HistoricalWalletTransaction; source: IngestionSource; finality: Finality },
): Promise<PersistedTransaction> {
  const { chainTransaction, walletId } = input;
  const reconstruction = reconstructSwap(chainTransaction);
  const settlement = chainTransaction.settlement;
  const [inserted] = await transaction.insert(schema.walletTransactions).values({
    walletId, providerEventId: input.providerEventId, signature: chainTransaction.signature, instructionIndex: 0, innerInstructionIndex: -1, kind: reconstruction.kind, slot: chainTransaction.slot,
    occurredAt: chainTransaction.occurredAt, finality: input.finality, ingestionSource: input.source, finalizedAt: input.finality === "finalized" ? new Date() : null, succeeded: chainTransaction.succeeded,
    normalizedPayload: {
      providerType: chainTransaction.providerType, feeLamports: chainTransaction.feeLamports.toString(), feePayerIsWallet: chainTransaction.feePayerIsWallet,
      nativeSolDeltaLamports: chainTransaction.nativeSolDeltaLamports.toString(),
      settlement: { venue: settlement.venue, walletTokenAccountRentLamports: settlement.walletTokenAccountRentLamports.toString(), counterpartyWsolDeltaLamports: settlement.counterpartyWsolDeltaLamports?.toString() ?? null, tipLamports: settlement.tipLamports.toString(), movedMints: settlement.movedMints },
      issues: [...chainTransaction.issues, ...reconstruction.issues],
    },
  }).onConflictDoNothing({ target: [schema.walletTransactions.walletId, schema.walletTransactions.signature, schema.walletTransactions.instructionIndex, schema.walletTransactions.innerInstructionIndex] }).returning();

  if (!inserted) {
    // Already known (retry, duplicate delivery, or ingested by the other path). Never create trades again; only move finality forward.
    const [existing] = await transaction.select().from(schema.walletTransactions).where(and(
      eq(schema.walletTransactions.walletId, walletId), eq(schema.walletTransactions.signature, chainTransaction.signature),
      eq(schema.walletTransactions.instructionIndex, 0), eq(schema.walletTransactions.innerInstructionIndex, -1),
    )).limit(1);
    if (!existing) throw new Error("WALLET_TRANSACTION_CONFLICT_WITHOUT_ROW");
    if (existing.finality === "confirmed" && input.finality === "finalized") {
      await transaction.update(schema.walletTransactions).set({ finality: "finalized", finalizedAt: new Date() }).where(and(eq(schema.walletTransactions.id, existing.id), eq(schema.walletTransactions.finality, "confirmed")));
      return { created: false, transactionId: existing.id, finality: "finalized", tradesCreated: 0, kind: existing.kind };
    }
    return { created: false, transactionId: existing.id, finality: existing.finality as Finality, tradesCreated: 0, kind: existing.kind };
  }
  if (!chainTransaction.succeeded) return { created: true, transactionId: inserted.id, finality: input.finality, tradesCreated: 0, kind: reconstruction.kind };

  const tokenIds = new Map<string, string>();
  for (const [flowIndex, flow] of chainTransaction.tokenFlows.entries()) {
    let [token] = await transaction.insert(schema.tokens).values({ mint: flow.mint, decimals: flow.decimals }).onConflictDoNothing({ target: schema.tokens.mint }).returning();
    token ??= (await transaction.select().from(schema.tokens).where(eq(schema.tokens.mint, flow.mint)).limit(1))[0];
    if (!token) throw new Error("TOKEN_UPSERT_FAILED");
    tokenIds.set(flow.mint, token.id);
    await transaction.insert(schema.transactionTokenFlows).values({ transactionId: inserted.id, tokenId: token.id, direction: flow.direction, rawAmount: flow.rawAmount.toString(), decimals: flow.decimals, account: flow.account, counterparty: flow.counterparty, flowIndex }).onConflictDoNothing();
  }
  let tradesCreated = 0;
  for (const leg of reconstruction.legs) {
    const tokenId = tokenIds.get(leg.tokenMint);
    if (!tokenId) throw new Error("TRADE_TOKEN_NOT_FOUND");
    const rows = await transaction.insert(schema.walletTrades).values({
      walletId, transactionId: inserted.id, tokenId, side: leg.side, rawTokenAmount: leg.rawTokenAmount.toString(), tokenDecimals: leg.tokenDecimals,
      baseMint: leg.quote?.mint ?? null, rawBaseAmount: leg.quote?.rawAmount.toString() ?? null, baseDecimals: leg.quote?.decimals ?? null,
      spentMint: leg.spent?.mint ?? null, spentRawAmount: leg.spent?.rawAmount.toString() ?? null, spentDecimals: leg.spent?.decimals ?? null,
      receivedMint: leg.received?.mint ?? null, receivedRawAmount: leg.received?.rawAmount.toString() ?? null, receivedDecimals: leg.received?.decimals ?? null,
      considerationBasis: leg.consideration,
      feeUsd: null, estimatedUsdValue: null, executionPriceUsd: null, pricingStatus: "MISSING_PRICE",
      pricingState: leg.consideration === "AMBIGUOUS" ? "AMBIGUOUS_CONSIDERATION" : "RECONSTRUCTED_UNPRICED", valuationBasis: "UNAVAILABLE", pricingIssues: leg.issues,
      feeLamports: leg.feeLamports.toString(), networkFeeLamports: leg.networkFeeLamports.toString(), tipLamports: leg.tipLamports.toString(),
      rentExcludedLamports: leg.rentExcludedLamports.toString(), unattributedLamports: leg.unattributedLamports.toString(),
      wsolNormalized: leg.wsolNormalized, routed: leg.routed, routeAssets: leg.routeAssets, venue: leg.venue,
      quality: leg.consideration === "EXACT" ? "HIGH" : leg.consideration === "DERIVED" ? "MEDIUM" : "LOW", occurredAt: chainTransaction.occurredAt,
    }).onConflictDoNothing().returning({ id: schema.walletTrades.id });
    tradesCreated += rows.length;
  }
  return { created: true, transactionId: inserted.id, finality: input.finality, tradesCreated, kind: reconstruction.kind };
}
