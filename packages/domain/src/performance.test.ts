import { describe, expect, it } from "vitest";
import { assessPerformance, assessScoreEligibility, calculatePerformance, summarizeSales } from "./performance";
import { calculateFifoAccounting, type AccountingTrade } from "./pnl";

describe("wallet performance", () => {
  it("computes concentration and drawdown from priced realizations", () => {
    const metrics = calculatePerformance([
      { tokenMint: "A", realizedPnlUsd: "100", roi: "1", holdingSeconds: 10, realizedAt: new Date("2026-01-01") },
      { tokenMint: "B", realizedPnlUsd: "-25", roi: "-0.25", holdingSeconds: 30, realizedAt: new Date("2026-01-02") },
      { tokenMint: "C", realizedPnlUsd: "50", roi: "0.5", holdingSeconds: 20, realizedAt: new Date("2026-01-03") },
    ], new Date("2026-01-04"), 7);
    expect(metrics.realizedPnlUsd).toBe("125");
    expect(metrics.profitExcludingLargestUsd).toBe("25");
    expect(metrics.maxDrawdownUsd).toBe("25");
    expect(metrics.medianHoldingSeconds).toBe(20);
  });

  it("degrades confidence instead of treating missing prices as zero", () => {
    const metrics = calculatePerformance([{ tokenMint: "A", realizedPnlUsd: null, roi: null, holdingSeconds: 1, realizedAt: new Date("2026-01-01") }], new Date("2026-01-02"), 7);
    expect(metrics.realizedPnlUsd).toBeNull();
    expect(metrics.quality).toBe("LOW");
  });
});

describe("sale summaries and evidence requirements", () => {
  const day = (n: number) => new Date(`2026-03-${String(n).padStart(2, "0")}T00:00:00Z`);
  const build = (count: number, unpricedEvery = 0) => {
    const trades: AccountingTrade[] = [];
    for (let index = 0; index < count; index += 1) {
      const priced = unpricedEvery === 0 || index % unpricedEvery !== 0;
      trades.push(
        { id: `b${String(index)}`, tokenMint: `M${String(index)}`, side: "BUY", rawTokenAmount: 10n, grossUsd: priced ? "10" : null, feeUsd: "0", occurredAt: day(1 + (index % 20)), confidenceBps: 9000 },
        { id: `s${String(index)}`, tokenMint: `M${String(index)}`, side: "SELL", rawTokenAmount: 10n, grossUsd: "15", feeUsd: "0", occurredAt: day(21 + (index % 8)), confidenceBps: 9000 },
      );
    }
    return trades;
  };
  const asOf = day(30);

  it("summarizes one row per sale and marks fully priced sales as evidence", () => {
    const trades = build(6);
    const sales = summarizeSales(trades, calculateFifoAccounting(trades));
    expect(sales).toHaveLength(6);
    expect(sales.every((sale) => sale.qualifying && sale.realizedPnlUsd === "5")).toBe(true);
  });

  it("excludes sales with unknown cost basis or no inventory from evidence", () => {
    const trades = [...build(4, 2), { id: "orphan", tokenMint: "Z", side: "SELL" as const, rawTokenAmount: 5n, grossUsd: "9", feeUsd: "0", occurredAt: day(25), confidenceBps: 9000 }];
    const sales = summarizeSales(trades, calculateFifoAccounting(trades));
    expect(sales.filter((sale) => !sale.qualifying)).toHaveLength(3);
    expect(sales.find((sale) => sale.saleId === "orphan")?.reasons).toContain("SOLD_WITHOUT_KNOWN_INVENTORY");
  });

  it("refuses a low-confidence sale as evidence", () => {
    const trades: AccountingTrade[] = [
      { id: "b", tokenMint: "M", side: "BUY", rawTokenAmount: 10n, grossUsd: "10", feeUsd: "0", occurredAt: day(1), confidenceBps: 4000 },
      { id: "s", tokenMint: "M", side: "SELL", rawTokenAmount: 10n, grossUsd: "15", feeUsd: "0", occurredAt: day(2), confidenceBps: 9000 },
    ];
    const [sale] = summarizeSales(trades, calculateFifoAccounting(trades));
    expect(sale).toMatchObject({ qualifying: false, confidenceBps: 4000 });
    expect(sale?.reasons).toContain("LOW_PRICING_CONFIDENCE");
  });

  it("computes window metrics from trustworthy sales only and only when the sample is sufficient", () => {
    const trades = build(12);
    const sales = summarizeSales(trades, calculateFifoAccounting(trades));
    const thirty = assessPerformance(sales, asOf, { days: 30, minSales: 10 });
    expect(thirty).toMatchObject({ eligible: true, qualifyingSales: 12, coverageBps: 10_000 });
    expect(thirty.metrics?.realizedPnlUsd).toBe("60");
    const seven = assessPerformance(sales, asOf, { days: 7, minSales: 5 });
    expect(seven.eligible).toBe(seven.qualifyingSales >= 5);
  });

  it("is not eligible, and produces no metrics, when too few sales are trustworthy", () => {
    const trades = build(12, 2);
    const sales = summarizeSales(trades, calculateFifoAccounting(trades));
    const result = assessPerformance(sales, asOf, { days: 30, minSales: 10 });
    expect(result.eligible).toBe(false);
    expect(result.metrics).toBeNull();
    expect(result.reasons).toEqual(expect.arrayContaining(["FEWER_THAN_10_TRUSTWORTHY_SALES", "LOW_EVIDENCE_COVERAGE"]));
  });

  it("withholds a wallet score for small samples or missing inputs", () => {
    const trades = build(12);
    const sales = summarizeSales(trades, calculateFifoAccounting(trades));
    const ninety = assessPerformance(sales, asOf, { days: 90, minSales: 20 });
    expect(assessScoreEligibility({ ninetyDay: ninety, copyabilityInputsAvailable: true }).eligible).toBe(false);
    const big = build(40);
    const bigSales = summarizeSales(big, calculateFifoAccounting(big));
    const bigNinety = assessPerformance(bigSales, asOf, { days: 90, minSales: 20 });
    expect(assessScoreEligibility({ ninetyDay: bigNinety, copyabilityInputsAvailable: true })).toEqual({ eligible: true, reasons: [] });
    expect(assessScoreEligibility({ ninetyDay: bigNinety, copyabilityInputsAvailable: false }).reasons).toEqual(["COPYABILITY_INPUTS_NOT_AVAILABLE"]);
  });
});
