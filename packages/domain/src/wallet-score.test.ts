import { describe, expect, it } from "vitest";
import { scoreWallet, walletScoreVersion } from "./wallet-score";

describe("wallet scoring", () => {
  it("is versioned and penalizes tiny concentrated samples", () => {
    const base = { winRateBps: 7000, profitableTokenCount: 8, maxDrawdownBps: 2000, recentProfitabilityBps: 7000, copyableTradeRatioBps: 9000, allocationProfitRatioBps: 0, dataConfidenceBps: 9000 };
    const weak = scoreWallet({ ...base, completedTrades: 2, largestTradeProfitContributionBps: 9500 });
    const strong = scoreWallet({ ...base, completedTrades: 40, largestTradeProfitContributionBps: 2500 });
    expect(strong.version).toBe(walletScoreVersion);
    expect(strong.score).toBeGreaterThan(weak.score);
  });
});
