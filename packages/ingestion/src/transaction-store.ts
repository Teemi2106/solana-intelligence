import { and, eq } from "drizzle-orm";
import { canonicalStablecoins, classifyEconomicActions, reconstructEconomicLegs, reconstructSwap, WRAPPED_SOL_MINT, type CanonicalEconomicEvidence, type EconomicAction, type HistoricalWalletTransaction, type PositionEvidence, type TokenEnrichmentTier } from "@swi/domain";
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
  readonly enrichmentRequestIds: readonly string[];
  readonly economicActions: readonly EconomicAction[];
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
  input: { walletId: string; providerEventId: string; chainTransaction: HistoricalWalletTransaction; source: IngestionSource; finality: Finality; canonicalEvidence?: CanonicalEconomicEvidence },
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
      nativeTransferLamports: (chainTransaction.nativeTransferLamports ?? 0n).toString(),
      canonicalEvidence: input.canonicalEvidence ? { accountClosures: input.canonicalEvidence.accountClosures.map((closure) => ({ ...closure, preRawAmount: closure.preRawAmount?.toString() ?? null, rentReclaimedLamports: closure.rentReclaimedLamports.toString() })) } : null,
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
      return { created: false, transactionId: existing.id, finality: "finalized", tradesCreated: 0, kind: existing.kind, enrichmentRequestIds: [], economicActions: [] };
    }
    return { created: false, transactionId: existing.id, finality: existing.finality as Finality, tradesCreated: 0, kind: existing.kind, enrichmentRequestIds: [], economicActions: [] };
  }

  const tokenIds = new Map<string, string>();
  for (const [flowIndex, flow] of chainTransaction.tokenFlows.entries()) {
    let [token] = await transaction.insert(schema.tokens).values({ mint: flow.mint, decimals: flow.decimals }).onConflictDoNothing({ target: schema.tokens.mint }).returning();
    token ??= (await transaction.select().from(schema.tokens).where(eq(schema.tokens.mint, flow.mint)).limit(1))[0];
    if (!token) throw new Error("TOKEN_UPSERT_FAILED");
    tokenIds.set(flow.mint, token.id);
    if (chainTransaction.succeeded)
      await transaction.insert(schema.transactionTokenFlows).values({ transactionId: inserted.id, tokenId: token.id, direction: flow.direction, rawAmount: flow.rawAmount.toString(), decimals: flow.decimals, account: flow.account, counterparty: flow.counterparty, flowIndex }).onConflictDoNothing();
  }
  const meaningful = new Set(reconstruction.legs.map((leg) => leg.tokenMint));
  const routed = new Set(reconstruction.legs.flatMap((leg) => leg.routeAssets));
  const enrichmentRequestIds: string[] = [];
  const freshnessBucket = new Date(Math.floor(Date.now() / 300_000) * 300_000);
  for (const [mint, tokenId] of tokenIds) {
    const tier: TokenEnrichmentTier = !chainTransaction.succeeded
      ? "DISCOVERY_ONLY"
      : meaningful.has(mint) && mint !== WRAPPED_SOL_MINT && !canonicalStablecoins.has(mint)
        ? "FULL"
        : "REDUCED";
    await transaction.insert(schema.tokenDiscoveryEvidence).values({ tokenId, transactionId: inserted.id, tier, transactionSucceeded: chainTransaction.succeeded, observedAt: chainTransaction.occurredAt }).onConflictDoNothing();
    if (tier === "DISCOVERY_ONLY") continue;
    const [request] = await transaction.insert(schema.tokenEnrichmentRequests).values({
      tokenId,
      tier,
      reasons: [meaningful.has(mint) ? "WALLET_ASSET" : routed.has(mint) ? "ROUTING_INTERMEDIATE" : "OBSERVED_QUOTE_ASSET"],
      requestedComponents: tier === "FULL" ? ["IDENTITY", "MARKET", "HOLDERS"] : ["IDENTITY"],
      freshnessBucket,
    }).onConflictDoNothing().returning({ id: schema.tokenEnrichmentRequests.id });
    if (request) enrichmentRequestIds.push(request.id);
  }
  let tradesCreated = 0;
  if (chainTransaction.succeeded) for (const leg of reconstruction.legs) {
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
  const economicActions = input.source === "helius-webhook"
    ? await persistEconomicActions(transaction, { walletId, transactionId: inserted.id, chainTransaction, reconstruction, tokenIds, ...(input.canonicalEvidence ? { canonicalEvidence: input.canonicalEvidence } : {}) })
    : [];
  return { created: true, transactionId: inserted.id, finality: input.finality, tradesCreated, kind: reconstruction.kind, enrichmentRequestIds, economicActions };
}

const ECONOMIC_ACTION_CLASSIFICATION_VERSION = "live-economic-v1";

async function persistEconomicActions(transaction: DbTransaction, input: {
  walletId: string;
  transactionId: string;
  chainTransaction: HistoricalWalletTransaction;
  reconstruction: ReturnType<typeof reconstructSwap>;
  tokenIds: Map<string, string>;
  canonicalEvidence?: CanonicalEconomicEvidence;
}): Promise<readonly EconomicAction[]> {
  // Phase 2 deliberately retains its provider-type gate. Live classification may recover an otherwise UNKNOWN
  // swap only when the same deterministic reconstruction establishes attributable consideration.
  const reconstructedLegs = reconstructEconomicLegs(input.chainTransaction, input.reconstruction);
  for (const closure of input.canonicalEvidence?.accountClosures ?? []) {
    if (!closure.mint || input.tokenIds.has(closure.mint)) continue;
    let [token] = await transaction.insert(schema.tokens).values({ mint: closure.mint, decimals: closure.decimals }).onConflictDoNothing({ target: schema.tokens.mint }).returning();
    token ??= (await transaction.select().from(schema.tokens).where(eq(schema.tokens.mint, closure.mint)).limit(1))[0];
    if (token) input.tokenIds.set(closure.mint, token.id);
  }
  const positions = new Map<string, PositionEvidence>();
  const positionMints = new Set([...reconstructedLegs.map((leg) => leg.tokenMint), ...(input.canonicalEvidence?.accountClosures.flatMap((closure) => closure.mint ? [closure.mint] : []) ?? [])]);
  for (const mint of positionMints) {
    const tokenId = input.tokenIds.get(mint);
    if (!tokenId) continue;
    const [position] = await transaction.select().from(schema.walletPositions).where(and(eq(schema.walletPositions.walletId, input.walletId), eq(schema.walletPositions.tokenId, tokenId))).limit(1);
    if (position) positions.set(mint, { rawAmount: BigInt(position.rawAmount), complete: position.unknownBasisRawAmount === "0" });
  }
  const actions = classifyEconomicActions({
    succeeded: input.chainTransaction.succeeded,
    reconstructedLegs,
    tokenFlows: input.chainTransaction.tokenFlows,
    nativePrincipalLamports: input.chainTransaction.nativeTransferLamports ?? 0n,
    positions,
    ...(input.canonicalEvidence ? { canonicalEvidence: input.canonicalEvidence } : {}),
  });
  for (const [actionIndex, action] of actions.entries()) await transaction.insert(schema.walletEconomicActions).values({
    walletId: input.walletId, transactionId: input.transactionId, actionIndex, action: action.action,
    tokenId: action.tokenMint ? input.tokenIds.get(action.tokenMint) ?? null : null,
    rawTokenAmount: action.rawTokenAmount?.toString() ?? null, tokenDecimals: action.tokenDecimals,
    considerationMint: action.consideration?.mint ?? null, considerationRawAmount: action.consideration?.rawAmount.toString() ?? null, considerationDecimals: action.consideration?.decimals ?? null,
    positionBeforeRaw: action.positionBeforeRaw?.toString() ?? null, positionAfterRaw: action.positionAfterRaw?.toString() ?? null,
    positionImpactNumerator: action.positionImpactNumerator?.toString() ?? null, positionImpactDenominator: action.positionImpactDenominator?.toString() ?? null,
    confidence: action.confidence, evidence: action.evidence, providerType: input.chainTransaction.providerType,
    classificationVersion: ECONOMIC_ACTION_CLASSIFICATION_VERSION, occurredAt: input.chainTransaction.occurredAt,
    nativeDestination: action.nativeTransferEvidence?.destination ?? null, nativePreBalanceLamports: action.nativeTransferEvidence?.preBalanceLamports.toString() ?? null, nativePostBalanceLamports: action.nativeTransferEvidence?.postBalanceLamports.toString() ?? null, nativeTransferLamports: action.nativeTransferEvidence?.amountLamports.toString() ?? null, nativeFeeLamports: action.nativeTransferEvidence?.feeLamports.toString() ?? null,
  }).onConflictDoNothing();
  return actions;
}
