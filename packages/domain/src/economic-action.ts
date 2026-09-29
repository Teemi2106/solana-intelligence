import { reconstructSwap, type AssetAmount, type ReconstructedLeg, type ReconstructedSwap } from "./swap-economics";
import type { HistoricalWalletTransaction } from "./ports";

export const economicActionTypes = ["BUY", "SELL", "PARTIAL_EXIT", "FULL_EXIT", "TRANSFER_IN", "TRANSFER_OUT", "ACCOUNT_CLOSE", "UNRESOLVED"] as const;
export type EconomicActionType = (typeof economicActionTypes)[number];
export type EconomicActionConfidence = "HIGH" | "MEDIUM" | "LOW" | "INDETERMINATE";

export interface CanonicalAccountClosure {
  readonly account: string;
  readonly mint: string | null;
  readonly tokenProgram: string;
  readonly preRawAmount: bigint | null;
  readonly decimals: number | null;
  readonly rentReclaimedLamports: bigint;
}

export interface CanonicalEconomicEvidence {
  readonly accountClosures: readonly CanonicalAccountClosure[];
}

export interface PositionEvidence {
  readonly rawAmount: bigint;
  readonly complete: boolean;
}

export interface EconomicAction {
  readonly action: EconomicActionType;
  readonly tokenMint: string | null;
  readonly rawTokenAmount: bigint | null;
  readonly tokenDecimals: number | null;
  readonly consideration: AssetAmount | null;
  readonly positionBeforeRaw: bigint | null;
  readonly positionAfterRaw: bigint | null;
  /** Exact rational representation; consumers may render it without using floating point. */
  readonly positionImpactNumerator: bigint | null;
  readonly positionImpactDenominator: bigint | null;
  readonly confidence: EconomicActionConfidence;
  readonly evidence: readonly string[];
}

export interface EconomicActionInput {
  readonly succeeded: boolean;
  readonly reconstructedLegs: readonly ReconstructedLeg[];
  readonly tokenFlows: readonly { mint: string; direction: "IN" | "OUT"; rawAmount: bigint; decimals: number }[];
  readonly nativePrincipalLamports: bigint;
  readonly positions: ReadonlyMap<string, PositionEvidence>;
  readonly canonicalEvidence?: CanonicalEconomicEvidence;
}

/** Action-only recovery for provider UNKNOWN events; it never changes Phase 2 trade persistence/accounting. */
export function reconstructEconomicLegs(transaction: HistoricalWalletTransaction, phase2: ReconstructedSwap): readonly ReconstructedLeg[] {
  const candidate = phase2.legs.length > 0 ? phase2 : reconstructSwap({ ...transaction, providerType: "SWAP" });
  return candidate.legs.filter((leg) => leg.consideration !== "AMBIGUOUS" && leg.quote !== null);
}

const abs = (value: bigint) => value < 0n ? -value : value;

/** Deterministic, provider-type-independent classification over canonical wallet economics. */
export function classifyEconomicActions(input: EconomicActionInput): readonly EconomicAction[] {
  if (!input.succeeded) return [unresolved("FAILED_TRANSACTION")];
  if (input.reconstructedLegs.length > 0) return input.reconstructedLegs.map((leg) => classifyTrade(leg, input.positions.get(leg.tokenMint)));

  const closures = input.canonicalEvidence?.accountClosures ?? [];
  if (closures.length > 0) return closures.map((closure): EconomicAction => {
    const position = closure.mint ? input.positions.get(closure.mint) : undefined;
    return {
      action: "ACCOUNT_CLOSE", tokenMint: closure.mint, rawTokenAmount: closure.preRawAmount ?? 0n, tokenDecimals: closure.decimals,
      consideration: { mint: "So11111111111111111111111111111111111111112", rawAmount: closure.rentReclaimedLamports, decimals: 9 },
      positionBeforeRaw: position?.rawAmount ?? null, positionAfterRaw: position?.rawAmount ?? null,
      positionImpactNumerator: 0n, positionImpactDenominator: position ? (position.rawAmount === 0n ? 1n : position.rawAmount) : null,
      confidence: "HIGH", evidence: ["CANONICAL_TOKEN_CLOSE_ACCOUNT", "CANONICAL_PRE_TOKEN_BALANCE", "NATIVE_RENT_RECLAIMED"],
    };
  });

  const nets = new Map<string, { amount: bigint; decimals: number }>();
  for (const flow of input.tokenFlows) {
    const current = nets.get(flow.mint) ?? { amount: 0n, decimals: flow.decimals };
    current.amount += flow.direction === "IN" ? flow.rawAmount : -flow.rawAmount;
    nets.set(flow.mint, current);
  }
  const transfers = [...nets].filter(([, value]) => value.amount !== 0n).map(([mint, value]): EconomicAction => ({
    action: value.amount > 0n ? "TRANSFER_IN" : "TRANSFER_OUT", tokenMint: mint, rawTokenAmount: abs(value.amount), tokenDecimals: value.decimals,
    consideration: null, positionBeforeRaw: null, positionAfterRaw: null, positionImpactNumerator: null, positionImpactDenominator: null,
    confidence: "HIGH", evidence: ["CANONICAL_ONE_SIDED_TOKEN_FLOW", "NO_ATTRIBUTABLE_CONSIDERATION"],
  }));
  if (transfers.length > 0) return transfers;
  if (input.nativePrincipalLamports !== 0n) return [{
    action: input.nativePrincipalLamports > 0n ? "TRANSFER_IN" : "TRANSFER_OUT", tokenMint: null, rawTokenAmount: abs(input.nativePrincipalLamports), tokenDecimals: 9,
    consideration: null, positionBeforeRaw: null, positionAfterRaw: null, positionImpactNumerator: null, positionImpactDenominator: null,
    confidence: "HIGH", evidence: ["CANONICAL_NATIVE_SOL_DELTA", "FEES_AND_RENT_EXCLUDED", "NO_TOKEN_TRADE"],
  }];
  return [unresolved("INSUFFICIENT_ECONOMIC_EVIDENCE")];
}

function classifyTrade(leg: ReconstructedLeg, position: PositionEvidence | undefined): EconomicAction {
  if (leg.side === "BUY") return {
    action: "BUY", tokenMint: leg.tokenMint, rawTokenAmount: leg.rawTokenAmount, tokenDecimals: leg.tokenDecimals, consideration: leg.quote,
    positionBeforeRaw: position?.rawAmount ?? null, positionAfterRaw: position ? position.rawAmount + leg.rawTokenAmount : null,
    positionImpactNumerator: null, positionImpactDenominator: null, confidence: leg.consideration === "EXACT" ? "HIGH" : "MEDIUM",
    evidence: ["DETERMINISTIC_RECONSTRUCTED_BUY", `${leg.consideration}_CONSIDERATION`],
  };
  const complete = position?.complete === true && position.rawAmount > 0n && leg.rawTokenAmount <= position.rawAmount;
  const action = complete ? (leg.rawTokenAmount === position.rawAmount ? "FULL_EXIT" : "PARTIAL_EXIT") : "SELL";
  return {
    action, tokenMint: leg.tokenMint, rawTokenAmount: leg.rawTokenAmount, tokenDecimals: leg.tokenDecimals, consideration: leg.quote,
    positionBeforeRaw: position?.rawAmount ?? null, positionAfterRaw: complete ? position.rawAmount - leg.rawTokenAmount : null,
    positionImpactNumerator: complete ? leg.rawTokenAmount : null, positionImpactDenominator: complete ? position.rawAmount : null,
    confidence: complete && leg.consideration === "EXACT" ? "HIGH" : "MEDIUM",
    evidence: ["DETERMINISTIC_RECONSTRUCTED_SELL", `${leg.consideration}_CONSIDERATION`, complete ? "COMPLETE_PRE_TRANSACTION_POSITION" : "POSITION_IMPACT_INDETERMINATE"],
  };
}

function unresolved(reason: string): EconomicAction {
  return { action: "UNRESOLVED", tokenMint: null, rawTokenAmount: null, tokenDecimals: null, consideration: null, positionBeforeRaw: null, positionAfterRaw: null, positionImpactNumerator: null, positionImpactDenominator: null, confidence: "INDETERMINATE", evidence: [reason] };
}
