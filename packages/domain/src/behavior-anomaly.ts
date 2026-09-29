import { Decimal } from "./decimal-config";

export const BEHAVIOR_POLICY_VERSION = "behavior-v1";
export const behaviorPolicy = {
  recentDays: 30, longTermDays: 180, maxObservations: 2_000, incidentWindowMinutes: 30,
  quality: { lowCount: 20, mediumCount: 50, highCount: 200, lowDays: 14, mediumDays: 30, highDays: 90 },
  sequenceMinimums: { 2: 100, 3: 150, 4: 200 },
} as const;

export const behaviorFeatureKinds = ["POSITION_SIZE_SOL", "POSITION_SIZE_USD", "HOLDING_DURATION", "EXIT_FRACTION", "EXITS_PER_POSITION", "ENTRY_TO_FIRST_EXIT", "FIRST_EXIT_TO_FULL_EXIT", "ACTION_FREQUENCY_5M", "ACTION_FREQUENCY_1H", "TOKEN_TRANSFER_SIZE", "NATIVE_TRANSFER_SIZE", "NATIVE_BALANCE_FRACTION", "TRANSFER_DESTINATION_NOVELTY", "VENUE_NOVELTY", "ROUTE_COMPLEXITY", "ACTION_SEQUENCE"] as const;

/** FIFO methodology and canonical provenance-key encoding for historical holding durations. */
export const FIFO_ACCOUNTING_METHODOLOGY_VERSION = "fifo-v1";
export const HOLDING_DURATION_SOURCE_TYPE = "PHASE2_FIFO_REALIZATION";

/**
 * Canonical field order: version, wallet UUID, token UUID, sell-trade UUID,
 * acquisition-trade UUID, exact realized base-unit integer. UUIDs have a fixed
 * ASCII representation and the quantity is normalized through BigInt, so the
 * result is independent of insertion order, locale, timezone and row UUIDs.
 */
export function holdingDurationSemanticSourceId(input: {
  readonly walletId: string;
  readonly tokenId: string;
  readonly sellTradeId: string;
  readonly acquisitionTradeId: string;
  readonly realizedRawAmount: bigint | string;
  readonly accountingMethodologyVersion?: string;
}): string {
  const version = input.accountingMethodologyVersion ?? FIFO_ACCOUNTING_METHODOLOGY_VERSION;
  const raw = BigInt(input.realizedRawAmount).toString();
  if (BigInt(raw) <= 0n) throw new RangeError("REALIZED_RAW_AMOUNT_MUST_BE_POSITIVE");
  return `${version}|wallet=${input.walletId}|token=${input.tokenId}|sell=${input.sellTradeId}|acquisition=${input.acquisitionTradeId}|raw=${raw}`;
}
export type BehaviorFeatureKind = (typeof behaviorFeatureKinds)[number];
export type BaselineQuality = "INSUFFICIENT" | "LOW" | "MEDIUM" | "HIGH";
export type AnomalySeverity = "NOTABLE" | "UNUSUAL" | "EXTREME";
export type AnomalyFamily = "SIZE" | "DURATION" | "EXIT" | "FREQUENCY" | "TRANSFER" | "VENUE_ROUTE" | "SEQUENCE";

export interface NumericStatistics {
  readonly count: number;
  readonly minimum: string;
  readonly q1: string;
  readonly median: string;
  readonly q3: string;
  readonly maximum: string;
  readonly mad: string;
}

const quantile = (sorted: readonly Decimal[], numerator: number, denominator: number): Decimal => {
  if (sorted.length === 0) throw new RangeError("EMPTY_DISTRIBUTION");
  const scaled = (sorted.length - 1) * numerator;
  const lower = Math.floor(scaled / denominator);
  const remainder = scaled % denominator;
  const a = sorted[lower];
  const b = sorted[Math.min(lower + 1, sorted.length - 1)];
  if (!a || !b) throw new RangeError("INVALID_QUANTILE_INDEX");
  return remainder === 0 ? a : a.plus(b.minus(a).mul(remainder).div(denominator));
};

export function numericStatistics(values: readonly string[]): NumericStatistics | null {
  if (values.length === 0) return null;
  const sorted = values.map((value) => new Decimal(value)).sort((a, b) => a.comparedTo(b));
  const median = quantile(sorted, 1, 2);
  const deviations = sorted.map((value) => value.minus(median).abs()).sort((a, b) => a.comparedTo(b));
  return { count: sorted.length, minimum: sorted[0]?.toFixed() ?? "0", q1: quantile(sorted, 1, 4).toFixed(), median: median.toFixed(), q3: quantile(sorted, 3, 4).toFixed(), maximum: sorted.at(-1)?.toFixed() ?? "0", mad: quantile(deviations, 1, 2).toFixed() };
}

/** Empirical percentile interval. Claims are suppressed until at least 20 comparable observations exist. */
export function empiricalPercentile(value: string, values: readonly string[]): { lowerBps: number; upperBps: number } | null {
  if (values.length < behaviorPolicy.quality.lowCount) return null;
  const target = new Decimal(value);
  let below = 0;
  let equal = 0;
  for (const item of values) {
    const comparison = new Decimal(item).comparedTo(target);
    if (comparison < 0) below += 1;
    else if (comparison === 0) equal += 1;
  }
  return { lowerBps: Math.floor(below * 10_000 / values.length), upperBps: Math.floor((below + equal) * 10_000 / values.length) };
}

export function baselineQuality(input: { count: number; coverageDays: number; historyComplete: boolean; completenessBps?: number }): BaselineQuality {
  if (!input.historyComplete || input.count < behaviorPolicy.quality.lowCount) return "INSUFFICIENT";
  if (input.count >= behaviorPolicy.quality.highCount && input.coverageDays >= behaviorPolicy.quality.highDays && (input.completenessBps ?? 10_000) >= 9_500) return "HIGH";
  if (input.count >= behaviorPolicy.quality.mediumCount && input.coverageDays >= behaviorPolicy.quality.mediumDays && (input.completenessBps ?? 10_000) >= 8_000) return "MEDIUM";
  return input.coverageDays >= behaviorPolicy.quality.lowDays ? "LOW" : "INSUFFICIENT";
}

export const actionGapBucket = (milliseconds: number): "LE_5M" | "GT_5M_LE_30M" | "GT_30M_LE_6H" | "GT_6H" => milliseconds <= 5 * 60_000 ? "LE_5M" : milliseconds <= 30 * 60_000 ? "GT_5M_LE_30M" : milliseconds <= 6 * 60 * 60_000 ? "GT_30M_LE_6H" : "GT_6H";

export function actionNgrams(actions: readonly { action: string; occurredAt: Date }[], length: 2 | 3 | 4): string[] {
  if (actions.length < length) return [];
  return Array.from({ length: actions.length - length + 1 }, (_, start) => actions.slice(start, start + length).map((item, index, items) => index === 0 ? item.action : `${actionGapBucket(item.occurredAt.getTime() - (items[index - 1]?.occurredAt.getTime() ?? item.occurredAt.getTime()))}:${item.action}`).join("→"));
}

export interface AnomalyFactInput { readonly family: AnomalyFamily; readonly tier: AnomalySeverity; readonly baselineQuality: BaselineQuality; }

export function deriveIncidentSeverity(facts: readonly AnomalyFactInput[]): { severity: AnomalySeverity | null; ruleIds: readonly string[]; families: readonly AnomalyFamily[] } {
  const eligible = facts.filter((fact) => fact.baselineQuality !== "INSUFFICIENT");
  const families = [...new Set(eligible.map((fact) => fact.family))];
  const extremeHigh = eligible.some((fact) => fact.tier === "EXTREME" && fact.baselineQuality === "HIGH");
  const unusualFamilies = new Set(eligible.filter((fact) => fact.tier === "UNUSUAL" || fact.tier === "EXTREME").map((fact) => fact.family));
  const notableFamilies = new Set(eligible.map((fact) => fact.family));
  if (extremeHigh) return { severity: "EXTREME", ruleIds: ["SEVERITY_V1_EXTREME_HIGH_BASELINE"], families };
  if (unusualFamilies.size >= 2) return { severity: "EXTREME", ruleIds: ["SEVERITY_V1_TWO_INDEPENDENT_UNUSUAL_FAMILIES"], families };
  if (eligible.some((fact) => fact.tier === "UNUSUAL" && fact.baselineQuality === "HIGH")) return { severity: "UNUSUAL", ruleIds: ["SEVERITY_V1_UNUSUAL_HIGH_BASELINE"], families };
  if (notableFamilies.size >= 2) return { severity: "UNUSUAL", ruleIds: ["SEVERITY_V1_TWO_INDEPENDENT_NOTABLE_FAMILIES"], families };
  if (eligible.length > 0) return { severity: "NOTABLE", ruleIds: ["SEVERITY_V1_SINGLE_NOTABLE_FACT"], families };
  return { severity: null, ruleIds: [], families: [] };
}
