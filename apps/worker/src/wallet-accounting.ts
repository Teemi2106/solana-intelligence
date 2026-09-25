import { and, asc, desc, eq, ne } from "drizzle-orm";
import { Decimal } from "decimal.js";
import {
  assessPerformance, defined, calculateFifoAccounting, performanceWindows, priceRequestsFor, priceTrade, pricedStates, quoteAssetKind, summarizeSales,
  type AccountingTrade, type ConsiderationBasis, type EntryTrade, type SaleForAllocation, type HistoricalPriceProvider, type HistoricalPriceResult, type PerformanceEligibility, type PricingState, type TradeForPricing,
} from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";

export interface AccountingDependencies {
  readonly database: Database;
  readonly prices: HistoricalPriceProvider;
}

export interface PricingSummary {
  readonly trades: number;
  readonly byState: Readonly<Partial<Record<PricingState, number>>>;
  readonly byBasis: Readonly<Record<string, number>>;
}

const lookupKey = (asset: string, at: Date) => `${asset}|${String(at.getTime())}`;
const chunk = <T>(items: readonly T[], size: number): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));

type TradeRow = typeof schema.walletTrades.$inferSelect & { tokenMint: string; orderKey: string };

/**
 * Only finalized transactions feed accounting. Confirmed (live) trades are displayed but never become inventory,
 * evidence or scores until finality is verified; dropped transactions are excluded permanently.
 */
async function loadTrades(database: Database, walletId: string, options: { finalizedOnly: boolean }): Promise<TradeRow[]> {
  const rows = await database.query.select({ trade: schema.walletTrades, tokenMint: schema.tokens.mint, slot: schema.walletTransactions.slot, signature: schema.walletTransactions.signature }).from(schema.walletTrades)
    .innerJoin(schema.tokens, eq(schema.walletTrades.tokenId, schema.tokens.id))
    .innerJoin(schema.walletTransactions, eq(schema.walletTrades.transactionId, schema.walletTransactions.id))
    .where(options.finalizedOnly ? and(eq(schema.walletTrades.walletId, walletId), eq(schema.walletTransactions.finality, "finalized")) : and(eq(schema.walletTrades.walletId, walletId), ne(schema.walletTransactions.finality, "dropped")))
    .orderBy(asc(schema.walletTrades.occurredAt), asc(schema.walletTransactions.slot), asc(schema.walletTransactions.signature), asc(schema.walletTrades.side));
  // Chain order is time, then slot. Within one slot the intra-block order is unknown, so acquisitions are
  // applied before disposals, then the signature breaks the remaining ties. Ids are random and never used.
  return rows.map((row) => ({ ...row.trade, tokenMint: row.tokenMint, orderKey: `${row.slot.toString().padStart(20, "0")}|${row.trade.side === "BUY" ? "0" : "1"}|${row.signature}|${row.trade.tokenId}` }));
}

function toPricingInput(row: TradeRow): TradeForPricing {
  const quote = row.baseMint !== null && row.rawBaseAmount !== null && row.baseDecimals !== null ? { mint: row.baseMint, rawAmount: BigInt(row.rawBaseAmount), decimals: row.baseDecimals } : null;
  return {
    side: row.side, tokenMint: row.tokenMint, rawTokenAmount: BigInt(row.rawTokenAmount), tokenDecimals: row.tokenDecimals, quote,
    quoteKind: quote ? quoteAssetKind(quote.mint, quote.decimals) : null,
    consideration: (row.considerationBasis ?? "AMBIGUOUS") as ConsiderationBasis,
    feeLamports: BigInt(row.feeLamports ?? "0"), occurredAt: row.occurredAt,
  };
}

/**
 * Prices every reconstructed trade from its own flows first (stablecoin, then SOL x timestamped SOL/USD),
 * falls back to an external history provider only where the flows cannot establish USD, and otherwise
 * persists the specific reason the trade is unpriced. The result depends only on persisted trades and the
 * persisted price observations, so re-running it is deterministic.
 */
export async function priceWalletTrades(dependencies: AccountingDependencies, walletId: string, options: { onlyPending?: boolean } = {}): Promise<PricingSummary> {
  // Confirmed trades are priced too so the live feed can show them; pricing never depends on finality.
  const all = await loadTrades(dependencies.database, walletId, { finalizedOnly: false });
  // Pending = never priced, or missing a price that a recovered provider may now supply. Already priced trades are immutable.
  const retryable: ReadonlySet<PricingState> = new Set<PricingState>(["RECONSTRUCTED_UNPRICED", "MISSING_QUOTE_USD_PRICE", "MISSING_HISTORICAL_PRICE"]);
  const rows = options.onlyPending ? all.filter((row) => retryable.has(row.pricingState)) : all;
  const inputs = rows.map(toPricingInput);
  const wanted = new Map<string, { asset: string; at: Date }>();
  for (const input of inputs) for (const request of priceRequestsFor(input)) wanted.set(lookupKey(request.asset, request.at), request);

  const results = new Map<string, HistoricalPriceResult>();
  // No database transaction is held while calling the network.
  for (const batch of chunk([...wanted.values()], 500)) {
    const answers = await dependencies.prices.getPrices(batch);
    batch.forEach((request, index) => {
      const answer = answers[index];
      if (answer) results.set(lookupKey(request.asset, request.at), answer);
    });
  }

  const byState: Partial<Record<PricingState, number>> = {};
  const byBasis: Record<string, number> = {};
  await dependencies.database.query.transaction(async (transaction) => {
    for (const [index, row] of rows.entries()) {
      const input = inputs[index];
      if (!input) continue;
      const pricing = priceTrade(input, (request) => results.get(lookupKey(request.asset, request.at)));
      byState[pricing.state] = (byState[pricing.state] ?? 0) + 1;
      byBasis[pricing.basis] = (byBasis[pricing.basis] ?? 0) + 1;
      const priced = pricedStates.has(pricing.state);
      await transaction.update(schema.walletTrades).set({
        pricingState: pricing.state, valuationBasis: pricing.basis, pricingStatus: priced ? "PRICED" : "MISSING_PRICE", pricingSource: pricing.source, pricingAt: pricing.pricedAt,
        pricingConfidenceBps: pricing.confidenceBps, executionPriceQuote: pricing.executionPriceQuote, executionPriceUsd: pricing.executionPriceUsd,
        estimatedUsdValue: pricing.considerationUsd, feeUsd: pricing.feeUsd, quoteUsdPrice: pricing.quoteUsdPrice, priceObservationId: pricing.priceObservationId,
        pricingIssues: [...new Set([...row.pricingIssues.filter((issue) => !issue.startsWith("SOL_USD_") && issue !== "FEE_USD_UNKNOWN" && !issue.startsWith("QUOTE_PRICE_") && !issue.startsWith("TOKEN_PRICE_")), ...pricing.issues])],
      }).where(eq(schema.walletTrades.id, row.id));
    }
  });
  return { trades: rows.length, byState, byBasis };
}

export interface AccountingReport {
  readonly closedPositions: number;
  readonly openPositions: number;
  readonly lots: number;
  readonly realizations: number;
  readonly salesTotal: number;
  readonly salesQualifying: number;
  readonly soldWithoutKnownInventory: number;
  readonly windows: readonly PerformanceEligibility[];
  /** Inputs for the wallet-intelligence step (copyability, allocation, score). */
  readonly evidenceInputs: {
    readonly entryTrades: readonly EntryTrade[];
    readonly saleAllocations: readonly (SaleForAllocation & { readonly transactionId: string })[];
    readonly tokenMints: readonly string[];
    readonly meanQualifyingConfidenceBps: number | null;
  };
}

/**
 * Rebuilds FIFO lots, realizations, positions and performance snapshots from priced trades.
 * Snapshots are computed only from sales whose pricing meets the evidence requirements; unrealized PnL stays
 * unknown because no reliable valuation price exists for the remaining long-tail inventory.
 */
export async function rebuildWalletAccounting(dependencies: AccountingDependencies, walletId: string, asOf: Date): Promise<AccountingReport> {
  const rows = await loadTrades(dependencies.database, walletId, { finalizedOnly: true });
  const trades: AccountingTrade[] = rows.map((row) => ({
    id: row.id, tokenMint: row.tokenMint, side: row.side, rawTokenAmount: BigInt(row.rawTokenAmount), grossUsd: row.estimatedUsdValue, feeUsd: row.feeUsd,
    occurredAt: row.occurredAt, orderKey: row.orderKey, confidenceBps: row.pricingConfidenceBps,
  }));
  const accounting = calculateFifoAccounting(trades);
  const sales = summarizeSales(trades, accounting);
  const windows = performanceWindows.map((window) => assessPerformance(sales, asOf, window));
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const tokenIdByMint = new Map(rows.map((row) => [row.tokenMint, row.tokenId]));

  const remainingByMint = new Map<string, { raw: bigint; knownBasis: Decimal; unknownRaw: bigint; hasKnown: boolean }>();
  for (const mint of tokenIdByMint.keys()) remainingByMint.set(mint, { raw: 0n, knownBasis: new Decimal(0), unknownRaw: 0n, hasKnown: false });
  for (const lot of accounting.lots) {
    const position = remainingByMint.get(lot.tokenMint);
    if (!position || lot.remainingRawAmount === 0n) continue;
    position.raw += lot.remainingRawAmount;
    if (lot.remainingCostBasisUsd === null) position.unknownRaw += lot.remainingRawAmount;
    else {
      position.knownBasis = position.knownBasis.plus(lot.remainingCostBasisUsd);
      position.hasKnown = true;
    }
  }

  await dependencies.database.query.transaction(async (transaction) => {
    await transaction.delete(schema.walletRealizations).where(eq(schema.walletRealizations.walletId, walletId));
    await transaction.delete(schema.walletInventoryLots).where(eq(schema.walletInventoryLots.walletId, walletId));
    await transaction.delete(schema.walletPositions).where(eq(schema.walletPositions.walletId, walletId));

    const lotIds = new Map<string, string>();
    for (const batch of chunk(accounting.lots, 200)) {
      const inserted = await transaction.insert(schema.walletInventoryLots).values(batch.map((lot) => {
        const source = defined(rowById.get(lot.sourceTradeId));
        const initialBasis = source.estimatedUsdValue === null ? null : new Decimal(source.estimatedUsdValue).plus(source.feeUsd ?? 0).toFixed();
        return {
          walletId, tokenId: source.tokenId, sourceTradeId: lot.sourceTradeId, sourceTransactionId: source.transactionId, basisSource: "PURCHASE" as const,
          acquiredRawAmount: lot.acquiredRawAmount.toString(), remainingRawAmount: lot.remainingRawAmount.toString(), costBasisUsd: initialBasis,
          remainingCostBasisUsd: lot.remainingCostBasisUsd?.toDecimalPlaces(18).toFixed() ?? null, confidenceBps: lot.confidenceBps, acquiredAt: lot.acquiredAt,
          quality: initialBasis === null ? "INSUFFICIENT" as const : source.quality,
        };
      })).returning({ id: schema.walletInventoryLots.id, sourceTradeId: schema.walletInventoryLots.sourceTradeId });
      for (const row of inserted) if (row.sourceTradeId) lotIds.set(row.sourceTradeId, row.id);
    }
    for (const batch of chunk(accounting.realizations, 200)) {
      await transaction.insert(schema.walletRealizations).values(batch.map((realization) => ({
        walletId, tokenId: defined(rowById.get(realization.sellTradeId)).tokenId, sellTradeId: realization.sellTradeId, lotId: defined(lotIds.get(realization.sourceTradeId)),
        rawAmount: realization.rawAmount.toString(), proceedsUsd: realization.proceedsUsd, costBasisUsd: realization.costBasisUsd, realizedPnlUsd: realization.realizedPnlUsd,
        roi: realization.roi === null ? null : new Decimal(realization.roi).toDecimalPlaces(10).toFixed(), holdingSeconds: realization.holdingSeconds,
        confidenceBps: realization.confidenceBps, issues: realization.issues, quality: realization.quality, realizedAt: realization.realizedAt,
      })));
    }
    for (const batch of chunk([...remainingByMint], 200)) {
      await transaction.insert(schema.walletPositions).values(batch.map(([mint, position]) => ({
        walletId, tokenId: defined(tokenIdByMint.get(mint)), rawAmount: position.raw.toString(), knownCostBasisUsd: position.hasKnown ? position.knownBasis.toDecimalPlaces(18).toFixed() : null,
        unknownBasisRawAmount: position.unknownRaw.toString(), marketValueUsd: null, unrealizedPnlUsd: null, priceObservedAt: null,
        quality: position.unknownRaw > 0n || !position.hasKnown && position.raw > 0n ? "LOW" as const : "HIGH" as const,
      })));
    }
    // Snapshots are append-only observations: a new row is written only when the observed values changed, never edited in place.
    for (const window of windows) {
      const metrics = window.metrics;
      const [latest] = await transaction.select().from(schema.walletPerformanceSnapshots).where(and(eq(schema.walletPerformanceSnapshots.walletId, walletId), eq(schema.walletPerformanceSnapshots.windowDays, window.windowDays))).orderBy(desc(schema.walletPerformanceSnapshots.observedAt)).limit(1);
      const unchanged = latest?.metrics["eligible"] === window.eligible && latest.metrics["totalSales"] === window.totalSales && latest.metrics["qualifyingSales"] === window.qualifyingSales
        && latest.quality === (metrics?.quality ?? "INSUFFICIENT") && (latest.realizedPnlUsd === null ? metrics?.realizedPnlUsd == null : metrics?.realizedPnlUsd != null && new Decimal(latest.realizedPnlUsd).equals(metrics.realizedPnlUsd));
      if (unchanged) continue;
      const snapshot = {
        walletId, windowDays: window.windowDays, realizedPnlUsd: metrics?.realizedPnlUsd ?? null, unrealizedPnlUsd: null, completedTrades: window.qualifyingSales,
        profitableTrades: metrics?.profitableTrades ?? 0, losingTrades: metrics?.losingTrades ?? 0, medianRoi: metrics?.medianRoi ?? null, averageRoi: metrics?.averageRoi ?? null,
        largestWinnerUsd: metrics?.largestWinnerUsd ?? null, largestLoserUsd: metrics?.largestLoserUsd ?? null, profitExcludingLargestUsd: metrics?.profitExcludingLargestUsd ?? null,
        largestTradeContribution: metrics?.largestTradeContribution ?? null,
        metrics: {
          eligible: window.eligible, reasons: window.reasons.join(","), totalSales: window.totalSales, qualifyingSales: window.qualifyingSales, coverageBps: window.coverageBps,
          winRateBps: metrics?.winRateBps ?? null, maxDrawdownUsd: metrics?.maxDrawdownUsd ?? null, medianHoldingSeconds: metrics?.medianHoldingSeconds ?? null,
        },
        quality: metrics?.quality ?? "INSUFFICIENT", observedAt: asOf,
      };
      // Re-observing the same instant (a replay with the same as-of time) refreshes that observation; a later time appends.
      await transaction.insert(schema.walletPerformanceSnapshots).values(snapshot).onConflictDoUpdate({ target: [schema.walletPerformanceSnapshots.walletId, schema.walletPerformanceSnapshots.windowDays, schema.walletPerformanceSnapshots.observedAt], set: snapshot });
    }
  });

  const everBought = new Set(accounting.lots.map((lot) => lot.tokenMint));
  let closed = 0;
  let open = 0;
  for (const [mint, position] of remainingByMint) {
    if (position.raw > 0n) open += 1;
    else if (everBought.has(mint)) closed += 1;
  }
  return {
    closedPositions: closed, openPositions: open, lots: accounting.lots.length, realizations: accounting.realizations.length,
    salesTotal: sales.length, salesQualifying: sales.filter((sale) => sale.qualifying).length, soldWithoutKnownInventory: Object.keys(accounting.saleDeficits).length,
    windows,
    evidenceInputs: {
      entryTrades: rows.filter((row) => row.side === "BUY").map((row) => ({ tradeId: row.id, transactionId: row.transactionId, tokenMint: row.tokenMint, occurredAt: row.occurredAt, routed: row.routed, venue: row.venue })),
      saleAllocations: rows.filter((row) => row.side === "SELL").map((row) => {
        const deficit = BigInt(accounting.saleDeficits[row.id] ?? "0");
        return { tokenMint: row.tokenMint, transactionId: row.transactionId, proceedsUsd: row.estimatedUsdValue, unbackedFraction: new Decimal(deficit.toString()).div(row.rawTokenAmount).toFixed() };
      }),
      tokenMints: [...tokenIdByMint.keys()].sort(),
      meanQualifyingConfidenceBps: (() => {
        const confidences = sales.flatMap((sale) => (sale.qualifying && sale.confidenceBps !== null ? [sale.confidenceBps] : []));
        return confidences.length === 0 ? null : Math.floor(confidences.reduce((sum, value) => sum + value, 0) / confidences.length);
      })(),
    },
  };
}

export async function processWalletAccounting(dependencies: AccountingDependencies, walletId: string, asOf: Date = new Date(), options: { onlyPending?: boolean } = {}): Promise<{ pricing: PricingSummary; accounting: AccountingReport }> {
  const pricing = await priceWalletTrades(dependencies, walletId, options);
  const accounting = await rebuildWalletAccounting(dependencies, walletId, asOf);
  return { pricing, accounting };
}
