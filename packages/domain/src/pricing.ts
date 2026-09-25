import { Decimal } from "./decimal-config";
import type { ConsiderationBasis } from "./swap-economics";
import type { QuoteAssetKind } from "./assets";
import { canonicalStablecoins, LAMPORTS_PER_SOL, WRAPPED_SOL_MINT } from "./assets";
import type { HistoricalPriceObservation, HistoricalPriceRequest, HistoricalPriceResult } from "./historical-price";

export const pricingStates = [
  "RECONSTRUCTED_UNPRICED",
  "PRICED_FROM_STABLECOIN_FLOW",
  "PRICED_FROM_SOL_FLOW",
  "PRICED_FROM_EXTERNAL_HISTORY",
  "MISSING_QUOTE_USD_PRICE",
  "MISSING_HISTORICAL_PRICE",
  "AMBIGUOUS_CONSIDERATION",
] as const;
export type PricingState = (typeof pricingStates)[number];

/** How the USD figure was obtained. */
export type ValuationBasis = "EXACT" | "DERIVED" | "EXTERNAL" | "UNAVAILABLE";

export const pricedStates: ReadonlySet<PricingState> = new Set<PricingState>(["PRICED_FROM_STABLECOIN_FLOW", "PRICED_FROM_SOL_FLOW", "PRICED_FROM_EXTERNAL_HISTORY"]);

export interface TradeForPricing {
  readonly side: "BUY" | "SELL";
  readonly tokenMint: string;
  readonly rawTokenAmount: bigint;
  readonly tokenDecimals: number;
  readonly quote: { readonly mint: string; readonly rawAmount: bigint; readonly decimals: number } | null;
  readonly quoteKind: QuoteAssetKind | null;
  readonly consideration: ConsiderationBasis;
  readonly feeLamports: bigint;
  readonly occurredAt: Date;
}

export interface TradePricing {
  readonly state: PricingState;
  readonly basis: ValuationBasis;
  readonly source: string | null;
  readonly pricedAt: Date | null;
  readonly confidenceBps: number | null;
  /** Quote units per whole token, from the swap's own flows. */
  readonly executionPriceQuote: string | null;
  readonly executionPriceUsd: string | null;
  readonly considerationUsd: string | null;
  readonly feeUsd: string | null;
  /** USD per quote unit that was applied (1 for canonical stablecoins). */
  readonly quoteUsdPrice: string | null;
  readonly priceObservationId: string | null;
  readonly issues: readonly string[];
}

/** Peg confidence for canonical stablecoins; a depeg is not modelled. */
export const STABLECOIN_PEG_CONFIDENCE_BPS = 9900;
const DERIVED_FLOW_CONFIDENCE_BPS = 8000;
const EXTERNAL_TOKEN_VALUATION_CAP_BPS = 6000;

const usd = (value: Decimal) => value.toDecimalPlaces(18).toFixed();
const scaled = (raw: bigint, decimals: number) => new Decimal(raw.toString()).div(new Decimal(10).pow(decimals));
const combine = (...values: number[]) => Math.floor(values.reduce((product, value) => (product * value) / 10_000, 10_000));

const unpriced = (state: PricingState, issues: readonly string[], executionPriceQuote: string | null = null, feeUsd: string | null = null): TradePricing => ({
  state, basis: "UNAVAILABLE", source: null, pricedAt: null, confidenceBps: null, executionPriceQuote, executionPriceUsd: null,
  considerationUsd: null, feeUsd, quoteUsdPrice: null, priceObservationId: null, issues,
});

/** The historical lookups a trade needs. SOL/USD is needed for SOL quotes and for lamport-denominated fees. */
export function priceRequestsFor(trade: TradeForPricing): HistoricalPriceRequest[] {
  const requests: HistoricalPriceRequest[] = [];
  if (trade.consideration === "AMBIGUOUS" || trade.quote === null) return requests;
  if (trade.quoteKind === "SOL" || trade.feeLamports > 0n) requests.push({ asset: WRAPPED_SOL_MINT, at: trade.occurredAt });
  if (trade.quoteKind === null) {
    requests.push({ asset: trade.quote.mint, at: trade.occurredAt });
    requests.push({ asset: trade.tokenMint, at: trade.occurredAt });
  }
  return requests;
}

export type PriceLookup = (request: HistoricalPriceRequest) => HistoricalPriceResult | undefined;

/**
 * Pricing hierarchy, most reliable first:
 * 1. canonical stablecoin flow  (USDC/USDT paid or received -> USD directly)
 * 2. SOL/wSOL flow              (lamports from the swap x timestamped SOL/USD)
 * 3. external history           (only for non-canonical quote assets, only if a provider covers them)
 * 4. unknown                    (persisted with the reason; never invented)
 */
export function priceTrade(trade: TradeForPricing, lookup: PriceLookup): TradePricing {
  if (trade.consideration === "AMBIGUOUS" || trade.quote === null) return unpriced("AMBIGUOUS_CONSIDERATION", ["CONSIDERATION_NOT_ESTABLISHED"]);
  if (trade.rawTokenAmount <= 0n || trade.quote.rawAmount <= 0n) return unpriced("AMBIGUOUS_CONSIDERATION", ["NON_POSITIVE_AMOUNT"]);

  const quoteAmount = scaled(trade.quote.rawAmount, trade.quote.decimals);
  const tokenAmount = scaled(trade.rawTokenAmount, trade.tokenDecimals);
  const executionPriceQuote = quoteAmount.div(tokenAmount).toDecimalPlaces(30).toFixed();
  const flowConfidence = trade.consideration === "EXACT" ? 10_000 : DERIVED_FLOW_CONFIDENCE_BPS;

  const needsSol = trade.feeLamports > 0n || trade.quoteKind === "SOL";
  const solUsd = needsSol ? lookup({ asset: WRAPPED_SOL_MINT, at: trade.occurredAt }) : undefined;
  const solObservation = solUsd?.status === "FOUND" ? solUsd.observation : null;
  const issues: string[] = [];
  let feeUsd: string | null = "0";
  if (trade.feeLamports > 0n) {
    if (solObservation) feeUsd = usd(new Decimal(trade.feeLamports.toString()).div(LAMPORTS_PER_SOL.toString()).mul(solObservation.priceUsd));
    else {
      feeUsd = null;
      issues.push("FEE_USD_UNKNOWN");
    }
  }

  const finish = (
    state: PricingState, basis: ValuationBasis, source: string, consideration: Decimal, quotePrice: Decimal, at: Date,
    confidence: number, observation: HistoricalPriceObservation | null, extraIssues: readonly string[] = [],
  ): TradePricing => ({
    state, basis, source, pricedAt: at, confidenceBps: confidence, executionPriceQuote,
    executionPriceUsd: usd(consideration.div(tokenAmount)), considerationUsd: usd(consideration), feeUsd,
    quoteUsdPrice: quotePrice.toDecimalPlaces(18).toFixed(), priceObservationId: observation?.observationId ?? null,
    issues: [...issues, ...extraIssues],
  });

  if (trade.quoteKind === "STABLECOIN") {
    const symbol = canonicalStablecoins.get(trade.quote.mint)?.symbol ?? "STABLECOIN";
    return finish("PRICED_FROM_STABLECOIN_FLOW", "EXACT", `STABLECOIN_PEG:${symbol}`, quoteAmount, new Decimal(1), trade.occurredAt, combine(flowConfidence, STABLECOIN_PEG_CONFIDENCE_BPS), null);
  }

  if (trade.quoteKind === "SOL") {
    if (!solObservation) return unpriced("MISSING_QUOTE_USD_PRICE", [...issues, solUsd ? `SOL_USD_${solUsd.status}` : "SOL_USD_NOT_REQUESTED"], executionPriceQuote, feeUsd);
    const price = new Decimal(solObservation.priceUsd);
    return finish("PRICED_FROM_SOL_FLOW", "DERIVED", `SOL_FLOW:${solObservation.provider}`, quoteAmount.mul(price), price, solObservation.observedAt, combine(flowConfidence, solObservation.confidenceBps), solObservation);
  }

  // Unknown / long-tail quote asset: the swap's own flows cannot be turned into USD without an independent price.
  const quoteResult = lookup({ asset: trade.quote.mint, at: trade.occurredAt });
  if (quoteResult?.status === "FOUND") {
    const observation = quoteResult.observation;
    const price = new Decimal(observation.priceUsd);
    return finish("PRICED_FROM_EXTERNAL_HISTORY", "EXTERNAL", `EXTERNAL_QUOTE:${observation.provider}`, quoteAmount.mul(price), price, observation.observedAt, combine(flowConfidence, observation.confidenceBps), observation);
  }
  const tokenResult = lookup({ asset: trade.tokenMint, at: trade.occurredAt });
  if (tokenResult?.status === "FOUND") {
    // A benchmark valuation of the token itself, not what the wallet paid: capped confidence.
    const observation = tokenResult.observation;
    const consideration = tokenAmount.mul(observation.priceUsd);
    return finish(
      "PRICED_FROM_EXTERNAL_HISTORY", "EXTERNAL", `EXTERNAL_TOKEN:${observation.provider}`, consideration, consideration.div(quoteAmount), observation.observedAt,
      Math.min(EXTERNAL_TOKEN_VALUATION_CAP_BPS, combine(flowConfidence, observation.confidenceBps)), observation, ["VALUED_FROM_TOKEN_PRICE_NOT_FLOW"],
    );
  }
  return unpriced("MISSING_HISTORICAL_PRICE", [...issues, "UNKNOWN_QUOTE_ASSET", `QUOTE_PRICE_${quoteResult?.status ?? "NOT_REQUESTED"}`, `TOKEN_PRICE_${tokenResult?.status ?? "NOT_REQUESTED"}`], executionPriceQuote, feeUsd);
}
