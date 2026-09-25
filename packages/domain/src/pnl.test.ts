import { describe, expect, it } from "vitest";
import { calculateFifoAccounting, calculateUnrealizedPnl, type AccountingTrade } from "./pnl";

const at = (day: number) => new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`);
const trade = (value: Partial<AccountingTrade> & Pick<AccountingTrade, "id" | "side" | "rawTokenAmount" | "occurredAt">): AccountingTrade => ({ tokenMint: "TOKEN", grossUsd: null, feeUsd: null, ...value });

describe("FIFO accounting", () => {
  it("handles multiple entries and partial exits with fees deterministically", () => {
    const result = calculateFifoAccounting([
      trade({ id: "b1", side: "BUY", rawTokenAmount: 100n, grossUsd: "100", feeUsd: "1", occurredAt: at(1) }),
      trade({ id: "b2", side: "BUY", rawTokenAmount: 100n, grossUsd: "200", feeUsd: "2", occurredAt: at(2) }),
      trade({ id: "s1", side: "SELL", rawTokenAmount: 150n, grossUsd: "450", feeUsd: "3", occurredAt: at(3) }),
      trade({ id: "s2", side: "SELL", rawTokenAmount: 25n, grossUsd: "100", feeUsd: "1", occurredAt: at(4) }),
    ]);
    expect(result.realizations.map((item) => item.realizedPnlUsd)).toEqual(["197", "48", "48.5"]);
    expect(result.lots.map((lot) => lot.remainingRawAmount)).toEqual([0n, 25n]);
    expect(result.lots[1]?.remainingCostBasisUsd?.toFixed()).toBe("50.5");
  });

  it("keeps missing prices unknown", () => {
    const result = calculateFifoAccounting([
      trade({ id: "b", side: "BUY", rawTokenAmount: 10n, occurredAt: at(1) }),
      trade({ id: "s", side: "SELL", rawTokenAmount: 5n, grossUsd: "10", occurredAt: at(2) }),
    ]);
    expect(result.realizations[0]?.realizedPnlUsd).toBeNull();
    expect(result.realizations[0]?.issues).toContain("UNKNOWN_COST_BASIS");
  });

  it("does not invent basis for inventory deficits", () => {
    const result = calculateFifoAccounting([trade({ id: "s", side: "SELL", rawTokenAmount: 7n, grossUsd: "10", occurredAt: at(2) })]);
    expect(result.unmatchedSales).toEqual({ TOKEN: "7" });
  });
});

describe("unrealized PnL", () => {
  it("uses token decimals without floating point", () => {
    expect(calculateUnrealizedPnl({ rawAmount: 1_500_000n, decimals: 6, knownCostBasisUsd: "1", priceUsd: "2" })).toBe("2");
  });
  it("returns unknown when price is missing", () => {
    expect(calculateUnrealizedPnl({ rawAmount: 1n, decimals: 0, knownCostBasisUsd: "1", priceUsd: null })).toBeNull();
  });
});

describe("FIFO edge cases", () => {
  it("leaves the remainder of a partially sold lot with a pro-rata basis", () => {
    const result = calculateFifoAccounting([
      trade({ id: "b", side: "BUY", rawTokenAmount: 1_000n, grossUsd: "100", feeUsd: "0", occurredAt: at(1) }),
      trade({ id: "s", side: "SELL", rawTokenAmount: 250n, grossUsd: "50", feeUsd: "0", occurredAt: at(2) }),
    ]);
    expect(result.realizations[0]).toMatchObject({ rawAmount: 250n, costBasisUsd: "25", proceedsUsd: "50", realizedPnlUsd: "25", roi: "1" });
    expect(result.lots[0]?.remainingRawAmount).toBe(750n);
    expect(result.lots[0]?.remainingCostBasisUsd?.toFixed()).toBe("75");
  });

  it("realizes repeated sells against the same lot without exceeding it", () => {
    const result = calculateFifoAccounting([
      trade({ id: "b", side: "BUY", rawTokenAmount: 100n, grossUsd: "100", feeUsd: "0", occurredAt: at(1) }),
      trade({ id: "s1", side: "SELL", rawTokenAmount: 40n, grossUsd: "80", feeUsd: "0", occurredAt: at(2) }),
      trade({ id: "s2", side: "SELL", rawTokenAmount: 60n, grossUsd: "30", feeUsd: "0", occurredAt: at(3) }),
      trade({ id: "s3", side: "SELL", rawTokenAmount: 5n, grossUsd: "5", feeUsd: "0", occurredAt: at(4) }),
    ]);
    expect(result.realizations.map((row) => [row.sellTradeId, row.realizedPnlUsd])).toEqual([["s1", "40"], ["s2", "-30"]]);
    expect(result.lots[0]?.remainingRawAmount).toBe(0n);
    expect(result.saleDeficits).toEqual({ s3: "5" });
  });

  it("treats an unknown fee as a soft issue, not as missing evidence", () => {
    const result = calculateFifoAccounting([
      trade({ id: "b", side: "BUY", rawTokenAmount: 10n, grossUsd: "10", feeUsd: "0", occurredAt: at(1), confidenceBps: 9000 }),
      trade({ id: "s", side: "SELL", rawTokenAmount: 10n, grossUsd: "12", feeUsd: null, occurredAt: at(2), confidenceBps: 9000 }),
    ]);
    expect(result.realizations[0]).toMatchObject({ realizedPnlUsd: "2", quality: "MEDIUM", confidenceBps: 9000 });
    expect(result.realizations[0]?.issues).toContain("UNKNOWN_SALE_FEE_TREATED_AS_ZERO");
  });

  it("orders trades that share a timestamp by the supplied stable key, not by random ids", () => {
    const trades = [
      trade({ id: "zzz", orderKey: "1|0|a", side: "BUY", rawTokenAmount: 10n, grossUsd: "10", feeUsd: "0", occurredAt: at(1) }),
      trade({ id: "aaa", orderKey: "1|1|b", side: "SELL", rawTokenAmount: 10n, grossUsd: "15", feeUsd: "0", occurredAt: at(1) }),
    ];
    const forward = calculateFifoAccounting(trades);
    const reversed = calculateFifoAccounting([...trades].reverse());
    expect(forward.realizations[0]?.realizedPnlUsd).toBe("5");
    expect(reversed.realizations).toEqual(forward.realizations);
    expect(forward.unmatchedSales).toEqual({});
  });

  it("keeps a valid trade with unknown USD value in inventory instead of dropping it", () => {
    const result = calculateFifoAccounting([trade({ id: "b", side: "BUY", rawTokenAmount: 10n, grossUsd: null, occurredAt: at(1) })]);
    expect(result.lots).toHaveLength(1);
    expect(result.lots[0]?.remainingCostBasisUsd).toBeNull();
  });
});
