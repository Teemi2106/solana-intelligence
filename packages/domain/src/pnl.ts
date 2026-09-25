import { Decimal } from "./decimal-config";


export type AccountingQuality = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export interface AccountingTrade {
  readonly id: string;
  readonly tokenMint: string;
  readonly side: "BUY" | "SELL";
  readonly rawTokenAmount: bigint;
  readonly grossUsd: string | null;
  readonly feeUsd: string | null;
  readonly occurredAt: Date;
  /**
   * Stable tie-breaker for trades sharing a timestamp (e.g. slot, side, signature). Falls back to id, which is
   * only deterministic when ids are; callers reprocessing from chain data should always supply it.
   */
  readonly orderKey?: string;
  /** Pricing confidence of the trade, when known. */
  readonly confidenceBps?: number | null;
}

export interface InventoryLot {
  readonly sourceTradeId: string;
  readonly tokenMint: string;
  readonly acquiredAt: Date;
  readonly acquiredRawAmount: bigint;
  remainingRawAmount: bigint;
  remainingCostBasisUsd: Decimal | null;
  readonly confidenceBps: number | null;
}

export interface Realization {
  readonly sellTradeId: string;
  readonly sourceTradeId: string;
  readonly tokenMint: string;
  readonly rawAmount: bigint;
  readonly proceedsUsd: string | null;
  readonly costBasisUsd: string | null;
  readonly realizedPnlUsd: string | null;
  readonly roi: string | null;
  readonly holdingSeconds: number;
  readonly quality: AccountingQuality;
  readonly confidenceBps: number | null;
  readonly realizedAt: Date;
  readonly issues: readonly string[];
}

export interface AccountingResult {
  readonly lots: readonly InventoryLot[];
  readonly realizations: readonly Realization[];
  /** Raw quantity sold per token mint with no inventory behind it (received outside a reconstructed trade). */
  readonly unmatchedSales: Readonly<Record<string, string>>;
  /** The same deficits keyed by sell trade id. */
  readonly saleDeficits: Readonly<Record<string, string>>;
}

function decimalOrNull(value: string | null): Decimal | null {
  return value === null ? null : new Decimal(value);
}

export function calculateFifoAccounting(trades: readonly AccountingTrade[]): AccountingResult {
  const lotsByMint = new Map<string, InventoryLot[]>();
  const realizations: Realization[] = [];
  const unmatched = new Map<string, bigint>();
  const deficits = new Map<string, bigint>();
  const ordered = [...trades].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.orderKey ?? a.id).localeCompare(b.orderKey ?? b.id));

  for (const trade of ordered) {
    if (trade.rawTokenAmount <= 0n) throw new RangeError("trade quantity must be positive");
    const gross = decimalOrNull(trade.grossUsd);
    const fee = decimalOrNull(trade.feeUsd) ?? new Decimal(0);
    const lots = lotsByMint.get(trade.tokenMint) ?? [];
    lotsByMint.set(trade.tokenMint, lots);

    if (trade.side === "BUY") {
      lots.push({
        sourceTradeId: trade.id,
        tokenMint: trade.tokenMint,
        acquiredAt: trade.occurredAt,
        acquiredRawAmount: trade.rawTokenAmount,
        remainingRawAmount: trade.rawTokenAmount,
        remainingCostBasisUsd: gross?.plus(fee) ?? null,
        confidenceBps: gross === null ? null : trade.confidenceBps ?? null,
      });
      continue;
    }

    let remainingSale = trade.rawTokenAmount;
    const netProceeds = gross?.minus(fee) ?? null;
    for (const lot of lots) {
      if (remainingSale === 0n) break;
      if (lot.remainingRawAmount === 0n) continue;
      const consumed = remainingSale < lot.remainingRawAmount ? remainingSale : lot.remainingRawAmount;
      const lotQuantityBefore = lot.remainingRawAmount;
      const saleFraction = new Decimal(consumed.toString()).div(trade.rawTokenAmount.toString());
      const lotFraction = new Decimal(consumed.toString()).div(lotQuantityBefore.toString());
      const proceeds = netProceeds?.mul(saleFraction) ?? null;
      const basis = lot.remainingCostBasisUsd?.mul(lotFraction) ?? null;
      const pnl = proceeds !== null && basis !== null ? proceeds.minus(basis) : null;
      const blocking = [gross === null ? "MISSING_SALE_PRICE" : null, lot.remainingCostBasisUsd === null ? "UNKNOWN_COST_BASIS" : null].filter((issue): issue is string => issue !== null);
      const issues = [...blocking, gross !== null && trade.feeUsd === null ? "UNKNOWN_SALE_FEE_TREATED_AS_ZERO" : null].filter((issue): issue is string => issue !== null);
      const confidences = [trade.confidenceBps ?? null, lot.confidenceBps];
      realizations.push({
        sellTradeId: trade.id,
        sourceTradeId: lot.sourceTradeId,
        tokenMint: trade.tokenMint,
        rawAmount: consumed,
        proceedsUsd: proceeds?.toFixed() ?? null,
        costBasisUsd: basis?.toFixed() ?? null,
        realizedPnlUsd: pnl?.toFixed() ?? null,
        roi: pnl !== null && basis?.greaterThan(0) ? pnl.div(basis).toFixed() : null,
        holdingSeconds: Math.max(0, Math.floor((trade.occurredAt.getTime() - lot.acquiredAt.getTime()) / 1000)),
        quality: blocking.length > 0 ? "INSUFFICIENT" : issues.length > 0 ? "MEDIUM" : "HIGH",
        confidenceBps: blocking.length > 0 || confidences.some((value) => value === null) ? null : Math.min(...confidences.filter((value): value is number => value !== null)),
        realizedAt: trade.occurredAt,
        issues,
      });
      lot.remainingRawAmount -= consumed;
      lot.remainingCostBasisUsd = lot.remainingCostBasisUsd?.minus(basis ?? 0) ?? null;
      remainingSale -= consumed;
    }
    if (remainingSale > 0n) {
      unmatched.set(trade.tokenMint, (unmatched.get(trade.tokenMint) ?? 0n) + remainingSale);
      deficits.set(trade.id, remainingSale);
    }
  }

  return { lots: [...lotsByMint.values()].flat(), realizations, unmatchedSales: Object.fromEntries([...unmatched].map(([mint, amount]) => [mint, amount.toString()])), saleDeficits: Object.fromEntries([...deficits].map(([id, amount]) => [id, amount.toString()])) };
}

export function calculateUnrealizedPnl(input: { rawAmount: bigint; decimals: number; knownCostBasisUsd: string | null; priceUsd: string | null }): string | null {
  if (input.knownCostBasisUsd === null || input.priceUsd === null || input.rawAmount < 0n) return null;
  const units = new Decimal(input.rawAmount.toString()).div(new Decimal(10).pow(input.decimals));
  return units.mul(input.priceUsd).minus(input.knownCostBasisUsd).toFixed();
}
