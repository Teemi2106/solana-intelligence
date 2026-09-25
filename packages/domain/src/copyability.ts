import { classifyWallet as classifyFromEvidence, type ClassificationEvidence, type ClassificationEvidenceType } from "./classification";
import { Decimal } from "./decimal-config";
import type { PerformanceEligibility } from "./performance";
import type { WalletClassification } from "./types";
import type { WalletScoreInputs, WalletScoreResult } from "./wallet-score";

/**
 * Copyability and allocation evidence.
 *
 * Everything here is derived from facts the system can establish: the wallet's own public-market swaps, the first
 * on-chain activity of a token, and inventory the wallet sold without any recorded purchase. Liquidity depth, motives
 * and off-chain relationships are NOT observable and are never inferred.
 */

/** An entry made fewer seconds after a token's first on-chain activity is treated as not reproducible by a follower. */
export const COPYABLE_MIN_SECONDS_AFTER_FIRST_ACTIVITY = 60;
/** Launch facts must exist for at least this share of entries before copyability may be judged. */
export const MIN_LAUNCH_FACT_COVERAGE_BPS = 8000;
/** Share of proceeds from non-public acquisition patterns at which an allocation-pattern classification is considered. */
export const ALLOCATION_PATTERN_MIN_SHARE_BPS = 3000;
/** Distinct tokens showing non-public acquisition before an allocation-pattern label is considered; one or two can simply mean incomplete history. */
export const ALLOCATION_PATTERN_MIN_TOKENS = 3;
export const COPYABLE_MIN_SCORE = 60;
export const COPYABLE_MIN_RATIO_BPS = 5000;

export interface LaunchFactInput {
  readonly status: "FOUND" | "UNAVAILABLE";
  readonly firstActivityAt: Date | null;
  readonly firstSigner: string | null;
}

export interface EntryTrade {
  readonly tradeId: string;
  readonly transactionId: string;
  readonly tokenMint: string;
  readonly occurredAt: Date;
  readonly routed: boolean;
  readonly venue: string | null;
}

export interface EntryEvidence {
  readonly tradeId: string;
  readonly transactionId: string;
  readonly tokenMint: string;
  readonly acquiredAt: Date;
  readonly routed: boolean;
  readonly venue: string | null;
  readonly launchFactsKnown: boolean;
  readonly secondsAfterFirstActivity: number | null;
  readonly walletSignedFirstTransaction: boolean;
  /** Public swap, launch timing known, at least the minimum delay after first activity, and not signed by the wallet itself. */
  readonly copyable: boolean | null;
}

/** One entry per token: the wallet's first public-market swap acquisition of it. */
export function buildEntryEvidence(buys: readonly EntryTrade[], launch: ReadonlyMap<string, LaunchFactInput>, walletAddress: string): EntryEvidence[] {
  const first = new Map<string, EntryTrade>();
  const ordered = [...buys].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.tradeId.localeCompare(b.tradeId));
  for (const buy of ordered) if (!first.has(buy.tokenMint)) first.set(buy.tokenMint, buy);
  return [...first.values()].map((buy) => {
    const fact = launch.get(buy.tokenMint);
    const firstActivityAt = fact?.status === "FOUND" ? fact.firstActivityAt : null;
    const seconds = firstActivityAt ? Math.floor((buy.occurredAt.getTime() - firstActivityAt.getTime()) / 1000) : null;
    const signedFirst = firstActivityAt !== null && fact?.firstSigner === walletAddress;
    return {
      tradeId: buy.tradeId, transactionId: buy.transactionId, tokenMint: buy.tokenMint, acquiredAt: buy.occurredAt, routed: buy.routed, venue: buy.venue,
      launchFactsKnown: firstActivityAt !== null, secondsAfterFirstActivity: seconds, walletSignedFirstTransaction: signedFirst,
      copyable: seconds === null ? null : seconds >= COPYABLE_MIN_SECONDS_AFTER_FIRST_ACTIVITY && !signedFirst,
    };
  });
}

export interface CopyabilitySummary {
  readonly entries: number;
  readonly entriesWithLaunchFacts: number;
  readonly coverageBps: number | null;
  /** null when launch-fact coverage is below the requirement (then the score inputs are incomplete). */
  readonly copyableTradeRatioBps: number | null;
}

export function summarizeCopyability(entries: readonly EntryEvidence[]): CopyabilitySummary {
  const known = entries.filter((entry) => entry.launchFactsKnown);
  const coverage = entries.length === 0 ? null : Math.floor((known.length * 10_000) / entries.length);
  const sufficient = coverage !== null && coverage >= MIN_LAUNCH_FACT_COVERAGE_BPS && known.length > 0;
  return {
    entries: entries.length, entriesWithLaunchFacts: known.length, coverageBps: coverage,
    copyableTradeRatioBps: sufficient ? Math.floor((known.filter((entry) => entry.copyable === true).length * 10_000) / known.length) : null,
  };
}

export interface SaleForAllocation {
  readonly tokenMint: string;
  readonly proceedsUsd: string | null;
  /** Fraction (0..1) of the sale that consumed no recorded purchase inventory, as a decimal string. */
  readonly unbackedFraction: string;
}

export interface AllocationSummary {
  /** Share of sale proceeds that came from inventory with no public-market acquisition on record, or from tokens the wallet launched itself. */
  readonly nonPublicProceedsShareBps: number | null;
  readonly nonPublicTokens: readonly string[];
}

export function summarizeAllocation(sales: readonly SaleForAllocation[], walletLaunchedMints: ReadonlySet<string>): AllocationSummary {
  let total = new Decimal(0);
  let nonPublic = new Decimal(0);
  const tokens = new Set<string>();
  for (const sale of sales) {
    if (sale.proceedsUsd === null) continue;
    const proceeds = new Decimal(sale.proceedsUsd);
    const fraction = walletLaunchedMints.has(sale.tokenMint) ? new Decimal(1) : new Decimal(sale.unbackedFraction);
    total = total.plus(proceeds);
    nonPublic = nonPublic.plus(proceeds.mul(fraction));
    if (fraction.greaterThan(0)) tokens.add(sale.tokenMint);
  }
  return { nonPublicProceedsShareBps: total.greaterThan(0) ? nonPublic.div(total).mul(10_000).floor().toNumber() : null, nonPublicTokens: [...tokens].sort() };
}

const toBps = (value: string | null): number | null => (value === null ? null : new Decimal(value).mul(10_000).floor().toNumber());

export interface ScoreInputSources {
  readonly ninetyDay: PerformanceEligibility;
  readonly thirtyDay: PerformanceEligibility;
  readonly copyability: CopyabilitySummary;
  readonly allocation: AllocationSummary;
  /** Mean pricing confidence (bps) of the qualifying sales. */
  readonly dataConfidenceBps: number | null;
}

/**
 * Maps established evidence onto wallet-score-v1 inputs. Returns null (score withheld) if any required input cannot be established.
 * Definitions: max drawdown is relative to the peak cumulative realized PnL; recent profitability is the 30D win rate.
 */
export function deriveScoreInputs(sources: ScoreInputSources): WalletScoreInputs | null {
  const metrics = sources.ninetyDay.metrics;
  if (!sources.ninetyDay.eligible || !metrics) return null;
  if (sources.copyability.copyableTradeRatioBps === null || sources.allocation.nonPublicProceedsShareBps === null || sources.dataConfidenceBps === null) return null;
  const peak = metrics.peakCumulativePnlUsd === null ? null : new Decimal(metrics.peakCumulativePnlUsd);
  const drawdownBps = peak?.greaterThan(0) && metrics.maxDrawdownUsd !== null ? Decimal.min(new Decimal(metrics.maxDrawdownUsd).div(peak), 1).mul(10_000).floor().toNumber() : 10_000;
  return {
    completedTrades: sources.ninetyDay.qualifyingSales,
    winRateBps: metrics.winRateBps,
    profitableTokenCount: metrics.profitableTokenCount,
    largestTradeProfitContributionBps: toBps(metrics.largestTradeContribution),
    maxDrawdownBps: drawdownBps,
    recentProfitabilityBps: sources.thirtyDay.metrics?.winRateBps ?? 0,
    copyableTradeRatioBps: sources.copyability.copyableTradeRatioBps,
    allocationProfitRatioBps: sources.allocation.nonPublicProceedsShareBps,
    dataConfidenceBps: sources.dataConfidenceBps,
  };
}

export interface ClassificationDecision {
  readonly classification: WalletClassification;
  readonly earlyAccessScore: number;
  readonly confidenceBps: number;
  readonly reasons: readonly string[];
}

/** Evidence that describes how inventory was acquired outside the public market, as opposed to how early a public entry was. */
const nonPublicAcquisitionTypes = new Set<ClassificationEvidenceType>(["DEPLOYER_LINKED_TRANSFER", "PRE_LAUNCH_RECIPIENT", "PRE_LIQUIDITY_HOLDER", "EARLY_ALLOCATION_PATTERN", "HIGH_ALLOCATION_DEPENDENCE"]);

/**
 * Two independent streams. The early-access stream comes from evidence via the existing evidence classifier, but timing alone
 * never qualifies: at least one piece of non-public-acquisition evidence is required, so a fast public buyer is not labelled
 * as an allocation pattern. Smart-money is judged separately from the score and copyability. RELATED_TEAM_LINKED needs
 * corroborated funding evidence, which Phase 3 does not collect. Labels describe observed patterns only.
 */
export function decideWalletClassification(input: { evidence: readonly ClassificationEvidence[]; score: WalletScoreResult | null; copyability: CopyabilitySummary; allocation: AllocationSummary }): ClassificationDecision {
  // Timing evidence (fast public entries) says nothing about how inventory was acquired, so it feeds neither the label nor the early-access score.
  const acquisitionEvidence = input.evidence.filter((item) => nonPublicAcquisitionTypes.has(item.type) || item.type === "RELATED_FUNDING_PATTERN");
  const fromEvidence = classifyFromEvidence(acquisitionEvidence);
  const tokensOf = (type: ClassificationEvidenceType | "ANY") => new Set(acquisitionEvidence.flatMap((item) => ((type === "ANY" || item.type === type) && typeof item.facts["tokenMint"] === "string" ? [item.facts["tokenMint"]] : [])));
  const nonPublicTokens = tokensOf("ANY");
  const deployerLinkedTokens = tokensOf("DEPLOYER_LINKED_TRANSFER");
  // Enough distinct tokens AND either a material share of proceeds from non-public inventory or repeated deployer-linked receipts.
  const materialPattern = nonPublicTokens.size >= ALLOCATION_PATTERN_MIN_TOKENS
    && ((input.allocation.nonPublicProceedsShareBps ?? 0) >= ALLOCATION_PATTERN_MIN_SHARE_BPS || deployerLinkedTokens.size >= ALLOCATION_PATTERN_MIN_TOKENS);
  if (fromEvidence.classification === "RELATED_TEAM_LINKED" || (fromEvidence.classification === "EARLY_ACCESS_ALLOCATION_PATTERN" && materialPattern)) {
    return { classification: fromEvidence.classification, earlyAccessScore: fromEvidence.earlyAccessScore, confidenceBps: fromEvidence.confidenceBps, reasons: [`ACQUISITION_EVIDENCE_ITEMS_${String(acquisitionEvidence.length)}`] };
  }
  const share = input.allocation.nonPublicProceedsShareBps;
  const ratio = input.copyability.copyableTradeRatioBps;
  if (input.score && input.score.score >= COPYABLE_MIN_SCORE && ratio !== null && ratio >= COPYABLE_MIN_RATIO_BPS && (share ?? 10_000) < ALLOCATION_PATTERN_MIN_SHARE_BPS) {
    return { classification: "COPYABLE_SMART_MONEY", earlyAccessScore: fromEvidence.earlyAccessScore, confidenceBps: Math.min(9000, input.score.score * 100), reasons: [`SCORE_${String(input.score.score)}`, `COPYABLE_RATIO_${String(ratio)}_BPS`] };
  }
  const reasons = acquisitionEvidence.length === 0
    ? [input.evidence.length > 0 ? "TIMING_EVIDENCE_ONLY" : input.score ? "THRESHOLDS_NOT_MET" : "SCORE_UNAVAILABLE"]
    : [nonPublicTokens.size < ALLOCATION_PATTERN_MIN_TOKENS ? "FEWER_THAN_3_NON_PUBLIC_TOKENS" : "NON_PUBLIC_SHARE_BELOW_THRESHOLD"];
  return { classification: "UNKNOWN_INSUFFICIENT_EVIDENCE", earlyAccessScore: fromEvidence.earlyAccessScore, confidenceBps: 0, reasons };
}
