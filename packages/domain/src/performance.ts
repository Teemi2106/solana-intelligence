import { Decimal } from "./decimal-config";
import type { AccountingResult, AccountingTrade } from "./pnl";

export interface CompletedRealization {
  readonly tokenMint: string;
  readonly realizedPnlUsd: string | null;
  readonly roi: string | null;
  readonly holdingSeconds: number;
  readonly realizedAt: Date;
}

export interface PerformanceMetrics {
  readonly realizedPnlUsd: string | null;
  readonly completedTrades: number;
  readonly profitableTrades: number;
  readonly losingTrades: number;
  readonly winRateBps: number | null;
  readonly medianRoi: string | null;
  readonly averageRoi: string | null;
  readonly averageHoldingSeconds: number | null;
  readonly medianHoldingSeconds: number | null;
  readonly largestWinnerUsd: string | null;
  readonly largestLoserUsd: string | null;
  readonly profitableTokenCount: number;
  readonly largestTradeContribution: string | null;
  readonly profitExcludingLargestUsd: string | null;
  readonly maxDrawdownUsd: string | null;
  /** Highest cumulative realized PnL reached in the window (>= 0); the base for a relative drawdown. */
  readonly peakCumulativePnlUsd: string | null;
  readonly quality: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
}

const medianDecimal = (values: readonly Decimal[]): Decimal | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (!value) return null;
  return sorted.length % 2 === 1 ? value : value.plus(sorted[middle - 1] ?? value).div(2);
};

export function calculatePerformance(realizations: readonly CompletedRealization[], asOf: Date, windowDays: number): PerformanceMetrics {
  const start = new Date(asOf.getTime() - windowDays * 86_400_000);
  const period = realizations.filter((item) => item.realizedAt >= start && item.realizedAt <= asOf);
  const priced = period.filter((item): item is CompletedRealization & { realizedPnlUsd: string } => item.realizedPnlUsd !== null);
  const profits = priced.map((item) => new Decimal(item.realizedPnlUsd));
  const rois = period.flatMap((item) => item.roi === null ? [] : [new Decimal(item.roi)]);
  const total = profits.length === 0 ? null : Decimal.sum(...profits);
  const winners = priced.filter((item) => new Decimal(item.realizedPnlUsd).isPositive());
  const losers = priced.filter((item) => new Decimal(item.realizedPnlUsd).isNegative());
  const largestWinner = winners.reduce<Decimal | null>((largest, item) => Decimal.max(largest ?? item.realizedPnlUsd, item.realizedPnlUsd), null);
  const largestLoser = losers.reduce<Decimal | null>((lowest, item) => Decimal.min(lowest ?? item.realizedPnlUsd, item.realizedPnlUsd), null);
  let cumulative = new Decimal(0); let peak = new Decimal(0); let maxDrawdown = new Decimal(0);
  for (const item of priced.sort((a, b) => a.realizedAt.getTime() - b.realizedAt.getTime())) { cumulative = cumulative.plus(item.realizedPnlUsd); peak = Decimal.max(peak, cumulative); maxDrawdown = Decimal.max(maxDrawdown, peak.minus(cumulative)); }
  const holding = period.map((item) => item.holdingSeconds).sort((a, b) => a - b);
  const holdingMiddle = Math.floor(holding.length / 2);
  const medianHolding = holding.length === 0 ? null : holding.length % 2 === 1 ? holding[holdingMiddle] ?? null : Math.round(((holding[holdingMiddle - 1] ?? 0) + (holding[holdingMiddle] ?? 0)) / 2);
  return {
    realizedPnlUsd: total?.toFixed() ?? null,
    completedTrades: period.length,
    profitableTrades: winners.length,
    losingTrades: losers.length,
    winRateBps: priced.length === 0 ? null : Math.round(winners.length / priced.length * 10_000),
    medianRoi: medianDecimal(rois)?.toFixed() ?? null,
    averageRoi: rois.length === 0 ? null : Decimal.sum(...rois).div(rois.length).toFixed(),
    averageHoldingSeconds: holding.length === 0 ? null : Math.round(holding.reduce((sum, value) => sum + value, 0) / holding.length),
    medianHoldingSeconds: medianHolding,
    largestWinnerUsd: largestWinner?.toFixed() ?? null,
    largestLoserUsd: largestLoser?.toFixed() ?? null,
    profitableTokenCount: new Set(winners.map((item) => item.tokenMint)).size,
    largestTradeContribution: total?.greaterThan(0) && largestWinner ? largestWinner.div(total).toFixed() : null,
    profitExcludingLargestUsd: total !== null && largestWinner ? total.minus(largestWinner).toFixed() : total?.toFixed() ?? null,
    maxDrawdownUsd: profits.length === 0 ? null : maxDrawdown.toFixed(),
    peakCumulativePnlUsd: profits.length === 0 ? null : peak.toFixed(),
    quality: period.length === 0 ? "INSUFFICIENT" : priced.length === period.length ? "HIGH" : priced.length / period.length >= 0.8 ? "MEDIUM" : "LOW",
  };
}

// ---- Sale-level summaries and evidence requirements ----------------------------------------------

/** A realization needs at least this pricing confidence to count as evidence. */
export const MIN_EVIDENCE_CONFIDENCE_BPS = 7000;
/** Share of a window's completed sales that must be trustworthy evidence. */
export const MIN_EVIDENCE_COVERAGE_BPS = 8000;
export const performanceWindows = [
  { days: 7, minSales: 5 },
  { days: 30, minSales: 10 },
  { days: 90, minSales: 20 },
] as const;
/** Trustworthy completed sales required (90D) before a wallet score may be produced. */
export const MIN_SCORE_SALES = 30;

export interface CompletedSale extends CompletedRealization {
  readonly saleId: string;
  readonly qualifying: boolean;
  readonly confidenceBps: number | null;
  readonly reasons: readonly string[];
}

/** One row per sell trade (not per matched lot), each marked as trustworthy evidence or not. */
export function summarizeSales(trades: readonly AccountingTrade[], accounting: AccountingResult): CompletedSale[] {
  const bySale = new Map<string, AccountingResult["realizations"][number][]>();
  for (const realization of accounting.realizations) bySale.set(realization.sellTradeId, [...(bySale.get(realization.sellTradeId) ?? []), realization]);
  return trades.filter((trade) => trade.side === "SELL").map((trade): CompletedSale => {
    const rows = bySale.get(trade.id) ?? [];
    const reasons = new Set<string>();
    if (accounting.saleDeficits[trade.id]) reasons.add("SOLD_WITHOUT_KNOWN_INVENTORY");
    if (rows.length === 0) reasons.add("NO_MATCHED_LOTS");
    for (const row of rows) for (const issue of row.issues) reasons.add(issue);
    const complete = rows.length > 0 && !accounting.saleDeficits[trade.id] && rows.every((row) => row.realizedPnlUsd !== null);
    const confidences = rows.map((row) => row.confidenceBps);
    const confidence = complete && confidences.every((value): value is number => value !== null) ? Math.min(...confidences) : null;
    if (complete && confidence === null) reasons.add("UNKNOWN_CONFIDENCE");
    if (confidence !== null && confidence < MIN_EVIDENCE_CONFIDENCE_BPS) reasons.add("LOW_PRICING_CONFIDENCE");
    const pnl = complete ? Decimal.sum(...rows.map((row) => row.realizedPnlUsd ?? "0")) : null;
    const basis = complete ? Decimal.sum(...rows.map((row) => row.costBasisUsd ?? "0")) : null;
    const totalRaw = rows.reduce((sum, row) => sum + row.rawAmount, 0n);
    const weightedHolding = totalRaw === 0n ? 0 : Number(rows.reduce((sum, row) => sum + BigInt(row.holdingSeconds) * row.rawAmount, 0n) / totalRaw);
    return {
      saleId: trade.id,
      tokenMint: trade.tokenMint,
      realizedPnlUsd: pnl?.toFixed() ?? null,
      roi: pnl !== null && basis?.greaterThan(0) ? pnl.div(basis).toFixed() : null,
      holdingSeconds: weightedHolding,
      realizedAt: trade.occurredAt,
      confidenceBps: confidence,
      qualifying: complete && confidence !== null && confidence >= MIN_EVIDENCE_CONFIDENCE_BPS,
      reasons: [...reasons].sort(),
    };
  });
}

export interface PerformanceEligibility {
  readonly windowDays: number;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly totalSales: number;
  readonly qualifyingSales: number;
  readonly coverageBps: number | null;
  /** Computed from qualifying sales only; null when the window is not eligible. */
  readonly metrics: PerformanceMetrics | null;
}

export function assessPerformance(sales: readonly CompletedSale[], asOf: Date, window: (typeof performanceWindows)[number]): PerformanceEligibility {
  const start = asOf.getTime() - window.days * 86_400_000;
  const inWindow = sales.filter((sale) => sale.realizedAt.getTime() >= start && sale.realizedAt <= asOf);
  const qualifying = inWindow.filter((sale) => sale.qualifying);
  const coverageBps = inWindow.length === 0 ? null : Math.floor((qualifying.length * 10_000) / inWindow.length);
  const reasons: string[] = [];
  if (qualifying.length < window.minSales) reasons.push(`FEWER_THAN_${String(window.minSales)}_TRUSTWORTHY_SALES`);
  if (coverageBps !== null && coverageBps < MIN_EVIDENCE_COVERAGE_BPS) reasons.push("LOW_EVIDENCE_COVERAGE");
  const eligible = reasons.length === 0;
  return { windowDays: window.days, eligible, reasons, totalSales: inWindow.length, qualifyingSales: qualifying.length, coverageBps, metrics: eligible ? calculatePerformance(qualifying, asOf, window.days) : null };
}

export interface ScoreEligibility {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
}

/**
 * A score needs a sufficient trustworthy sample AND every wallet-score-v1 input to exist.
 * Copyability/allocation inputs need Phase 3 evidence, so callers pass whether they are available.
 */
export function assessScoreEligibility(input: { ninetyDay: PerformanceEligibility; copyabilityInputsAvailable: boolean }): ScoreEligibility {
  const reasons: string[] = [];
  if (!input.ninetyDay.eligible) reasons.push("PERFORMANCE_90D_NOT_ELIGIBLE");
  if (input.ninetyDay.qualifyingSales < MIN_SCORE_SALES) reasons.push(`FEWER_THAN_${String(MIN_SCORE_SALES)}_TRUSTWORTHY_SALES`);
  if (!input.copyabilityInputsAvailable) reasons.push("COPYABILITY_INPUTS_NOT_AVAILABLE");
  return { eligible: reasons.length === 0, reasons };
}
