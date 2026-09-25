import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";
import { WRAPPED_SOL_MINT } from "./assets";
import type { HistoricalPriceRequest, HistoricalPriceResult } from "./historical-price";
import { summarizeSales } from "./performance";
import { calculateFifoAccounting, type AccountingTrade } from "./pnl";
import type { HistoricalWalletTransaction } from "./ports";
import type { TokenMint } from "./types";
import { priceRequestsFor, priceTrade } from "./pricing";
import { reconstructSwap } from "./swap-economics";

const TOKEN = "TokenAAAA11111111111111111111111111111111pump";
const tx = (signature: string, minute: number, nativeDelta: bigint, direction: "IN" | "OUT", raw: bigint): HistoricalWalletTransaction => ({
  signature: signature as HistoricalWalletTransaction["signature"], slot: BigInt(1_000 + minute), occurredAt: new Date(Date.UTC(2026, 8, 1, 12, minute, 30)), succeeded: true, providerType: "SWAP",
  feeLamports: 5_000n, feePayerIsWallet: true, nativeSolDeltaLamports: nativeDelta, source: "fixture", quality: "HIGH", issues: [],
  tokenFlows: [{ mint: TOKEN as TokenMint, direction, rawAmount: raw, decimals: 6, account: null, counterparty: null }],
  settlement: { venue: "PUMP_AMM", walletTokenAccountRentLamports: 0n, counterpartyWsolDeltaLamports: null, tipLamports: 0n, movedMints: [TOKEN, WRAPPED_SOL_MINT] },
});

// SOL/USD rises 100 -> 110 across the day: a historical price, never "the current price".
const solUsd = (request: HistoricalPriceRequest): HistoricalPriceResult => {
  const minute = request.at.getUTCMinutes();
  return { status: "FOUND", observation: { asset: request.asset, requestedAt: request.at, observedAt: new Date(Math.floor(request.at.getTime() / 60_000) * 60_000), priceUsd: String(100 + minute), provider: "fixture", granularitySeconds: 60, confidenceBps: 9500 } };
};

const transactions = [
  tx("buy1", 0, -1_000_005_000n, "IN", 100_000_000n),
  tx("buy2", 1, -2_000_005_000n, "IN", 100_000_000n),
  tx("sell1", 2, 5_000_000_000n - 5_000n, "OUT", 150_000_000n),
  tx("sell2", 3, 400_000_000n - 5_000n, "OUT", 50_000_000n),
];

function run(input: readonly HistoricalWalletTransaction[]) {
  const trades: AccountingTrade[] = input.flatMap((transaction) => reconstructSwap(transaction).legs.map((leg) => {
    const pricing = priceTrade({ ...leg, occurredAt: transaction.occurredAt, quote: leg.quote }, solUsd);
    expect(priceRequestsFor({ ...leg, occurredAt: transaction.occurredAt }).length).toBeGreaterThan(0);
    return { id: `${transaction.signature}:${leg.side}`, orderKey: `${transaction.slot.toString()}|${leg.side}|${transaction.signature}`, tokenMint: leg.tokenMint, side: leg.side, rawTokenAmount: leg.rawTokenAmount, grossUsd: pricing.considerationUsd, feeUsd: pricing.feeUsd, occurredAt: transaction.occurredAt, confidenceBps: pricing.confidenceBps };
  }));
  const accounting = calculateFifoAccounting(trades);
  return { trades, accounting, sales: summarizeSales(trades, accounting) };
}

describe("reconstruction -> pricing -> FIFO", () => {
  it("values each trade at the SOL/USD of its own timestamp and realizes FIFO PnL", () => {
    const { trades, accounting, sales } = run(transactions);
    expect(trades.map((trade) => trade.grossUsd)).toEqual(["100", "202", "510", "41.2"]);
    // Realized PnL = total net proceeds - total cost, with each fee valued at its own timestamp's SOL/USD.
    const total = accounting.realizations.reduce((sum, row) => sum.plus(row.realizedPnlUsd ?? "0"), new Decimal(0));
    expect(total.toDecimalPlaces(18).toFixed()).toBe("249.19797");
    expect(accounting.lots.map((lot) => lot.remainingRawAmount)).toEqual([0n, 0n]);
    expect(accounting.saleDeficits).toEqual({});
    expect(sales.every((sale) => sale.qualifying)).toBe(true);
  });

  it("is deterministic regardless of input order, and on repeated runs", () => {
    const forward = run(transactions);
    const shuffled = run([transactions[2], transactions[0], transactions[3], transactions[1]] as HistoricalWalletTransaction[]);
    const serialize = (result: ReturnType<typeof run>) => JSON.stringify(result.accounting, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialize(shuffled)).toBe(serialize(forward));
    expect(serialize(run(transactions))).toBe(serialize(forward));
    expect(JSON.stringify(shuffled.sales)).toBe(JSON.stringify(forward.sales));
  });
});
