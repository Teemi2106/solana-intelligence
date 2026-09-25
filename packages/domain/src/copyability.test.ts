import { describe, expect, it } from "vitest";
import type { ClassificationEvidence } from "./classification";
import {
  buildEntryEvidence, COPYABLE_MIN_SECONDS_AFTER_FIRST_ACTIVITY, decideWalletClassification, deriveScoreInputs, summarizeAllocation, summarizeCopyability, type CopyabilitySummary, type EntryTrade, type LaunchFactInput,
} from "./copyability";
import type { PerformanceEligibility, PerformanceMetrics } from "./performance";
import { scoreWallet } from "./wallet-score";

const WALLET = "WalletAddress111111111111111111111111111111";
const launchAt = new Date("2026-09-01T00:00:00Z");
const at = (seconds: number) => new Date(launchAt.getTime() + seconds * 1000);
const buy = (mint: string, seconds: number, extra: Partial<EntryTrade> = {}): EntryTrade => ({ tradeId: `t-${mint}-${String(seconds)}`, transactionId: `x-${mint}-${String(seconds)}`, tokenMint: mint, occurredAt: at(seconds), routed: false, venue: "PUMP_AMM", ...extra });
const found = (signer = "Deployer1111111111111111111111111111111111111"): LaunchFactInput => ({ status: "FOUND", firstActivityAt: launchAt, firstSigner: signer });

describe("entry evidence", () => {
  it("uses only the first public swap acquisition per token", () => {
    const entries = buildEntryEvidence([buy("A", 120), buy("A", 30), buy("B", 90)], new Map([["A", found()], ["B", found()]]), WALLET);
    expect(entries.map((entry) => [entry.tokenMint, entry.secondsAfterFirstActivity]).sort()).toEqual([["A", 30], ["B", 90]]);
  });

  it("judges copyability from time after first activity, not from anything about the wallet's motives", () => {
    const [early, later] = buildEntryEvidence([buy("A", COPYABLE_MIN_SECONDS_AFTER_FIRST_ACTIVITY - 1), buy("B", COPYABLE_MIN_SECONDS_AFTER_FIRST_ACTIVITY)], new Map([["A", found()], ["B", found()]]), WALLET);
    expect(early?.copyable).toBe(false);
    expect(later?.copyable).toBe(true);
  });

  it("does not call an entry copyable when the wallet signed the token's first transaction", () => {
    const [entry] = buildEntryEvidence([buy("A", 600)], new Map([["A", found(WALLET)]]), WALLET);
    expect(entry).toMatchObject({ walletSignedFirstTransaction: true, copyable: false });
  });

  it("leaves copyability unknown, never assumed, when launch facts are missing or unavailable", () => {
    const entries = buildEntryEvidence([buy("A", 600), buy("B", 600)], new Map<string, LaunchFactInput>([["B", { status: "UNAVAILABLE", firstActivityAt: null, firstSigner: null }]]), WALLET);
    expect(entries.map((entry) => [entry.launchFactsKnown, entry.copyable])).toEqual([[false, null], [false, null]]);
  });
});

describe("copyability summary", () => {
  const entries = (known: number, unknown: number, copyable: number) => [
    ...Array.from({ length: known }, (_, index) => ({ ...buildEntryEvidence([buy(`K${String(index)}`, index < copyable ? 600 : 5)], new Map([[`K${String(index)}`, found()]]), WALLET)[0] })),
    ...Array.from({ length: unknown }, (_, index) => ({ ...buildEntryEvidence([buy(`U${String(index)}`, 600)], new Map(), WALLET)[0] })),
  ] as ReturnType<typeof buildEntryEvidence>;

  it("computes the ratio from entries with known launch timing", () => {
    expect(summarizeCopyability(entries(10, 0, 4))).toMatchObject({ entries: 10, entriesWithLaunchFacts: 10, coverageBps: 10_000, copyableTradeRatioBps: 4_000 });
  });

  it("withholds the ratio when launch facts cover too little of the entries", () => {
    const summary = summarizeCopyability(entries(7, 3, 7));
    expect(summary.coverageBps).toBe(7_000);
    expect(summary.copyableTradeRatioBps).toBeNull();
  });

  it("has no ratio without entries", () => {
    expect(summarizeCopyability([])).toEqual({ entries: 0, entriesWithLaunchFacts: 0, coverageBps: null, copyableTradeRatioBps: null });
  });
});

describe("allocation dependence", () => {
  it("measures the share of proceeds from inventory with no public acquisition, using decimals", () => {
    const result = summarizeAllocation([
      { tokenMint: "A", proceedsUsd: "100", unbackedFraction: "0" },
      { tokenMint: "B", proceedsUsd: "100", unbackedFraction: "1" },
      { tokenMint: "C", proceedsUsd: "200", unbackedFraction: "0.25" },
    ], new Set());
    expect(result).toEqual({ nonPublicProceedsShareBps: 3750, nonPublicTokens: ["B", "C"] });
  });

  it("counts tokens the wallet launched itself as non-public acquisition", () => {
    expect(summarizeAllocation([{ tokenMint: "A", proceedsUsd: "50", unbackedFraction: "0" }, { tokenMint: "B", proceedsUsd: "50", unbackedFraction: "0" }], new Set(["A"]))).toEqual({ nonPublicProceedsShareBps: 5000, nonPublicTokens: ["A"] });
  });

  it("ignores unpriced sales and is unknown without any proceeds", () => {
    expect(summarizeAllocation([{ tokenMint: "A", proceedsUsd: null, unbackedFraction: "1" }], new Set())).toEqual({ nonPublicProceedsShareBps: null, nonPublicTokens: [] });
  });
});

const metrics = (overrides: Partial<PerformanceMetrics> = {}): PerformanceMetrics => ({
  realizedPnlUsd: "1000", completedTrades: 40, profitableTrades: 26, losingTrades: 14, winRateBps: 6500, medianRoi: "0.2", averageRoi: "0.3", averageHoldingSeconds: 300, medianHoldingSeconds: 250, largestWinnerUsd: "150", largestLoserUsd: "-80",
  profitableTokenCount: 20, largestTradeContribution: "0.15", profitExcludingLargestUsd: "850", maxDrawdownUsd: "200", peakCumulativePnlUsd: "1000", quality: "HIGH", ...overrides,
});
const window = (days: number, eligible: boolean, sales: number, m: PerformanceMetrics | null = metrics()): PerformanceEligibility => ({ windowDays: days, eligible, reasons: eligible ? [] : ["X"], totalSales: sales, qualifyingSales: sales, coverageBps: 10_000, metrics: eligible ? m : null });
const copyability = (ratio: number | null): CopyabilitySummary => ({ entries: 30, entriesWithLaunchFacts: 30, coverageBps: 10_000, copyableTradeRatioBps: ratio });

describe("wallet-score-v1 inputs", () => {
  const sources = { ninetyDay: window(90, true, 40), thirtyDay: window(30, true, 20, metrics({ winRateBps: 7000 })), copyability: copyability(6000), allocation: { nonPublicProceedsShareBps: 500, nonPublicTokens: [] }, dataConfidenceBps: 9000 };

  it("maps established evidence onto the score inputs", () => {
    expect(deriveScoreInputs(sources)).toEqual({
      completedTrades: 40, winRateBps: 6500, profitableTokenCount: 20, largestTradeProfitContributionBps: 1500, maxDrawdownBps: 2000, recentProfitabilityBps: 7000,
      copyableTradeRatioBps: 6000, allocationProfitRatioBps: 500, dataConfidenceBps: 9000,
    });
  });

  it.each([
    ["the 90D window is not eligible", { ...sources, ninetyDay: window(90, false, 5) }],
    ["copyability cannot be established", { ...sources, copyability: copyability(null) }],
    ["allocation share is unknown", { ...sources, allocation: { nonPublicProceedsShareBps: null, nonPublicTokens: [] } }],
    ["data confidence is unknown", { ...sources, dataConfidenceBps: null }],
  ])("withholds the score when %s", (_name, input) => {
    expect(deriveScoreInputs(input)).toBeNull();
  });

  it("treats a drawdown with no positive peak as the worst case rather than inventing a ratio", () => {
    const inputs = deriveScoreInputs({ ...sources, ninetyDay: window(90, true, 40, metrics({ peakCumulativePnlUsd: "0", maxDrawdownUsd: "50" })) });
    expect(inputs?.maxDrawdownBps).toBe(10_000);
  });
});

describe("classification decision", () => {
  const evidence = (type: ClassificationEvidence["type"]): ClassificationEvidence => ({ type, confidenceBps: 8000, observedAt: launchAt, facts: {} });
  const none = { entries: 0, entriesWithLaunchFacts: 0, coverageBps: null, copyableTradeRatioBps: null } satisfies CopyabilitySummary;
  const noAllocation = { nonPublicProceedsShareBps: null, nonPublicTokens: [] };

  it("never labels a fast public buyer as an allocation pattern on timing evidence alone", () => {
    const result = decideWalletClassification({ evidence: [evidence("NON_COPYABLE_ENTRY"), evidence("NON_COPYABLE_ENTRY"), evidence("NON_COPYABLE_ENTRY"), evidence("EARLY_LIQUIDITY_ENTRY"), evidence("EARLY_LIQUIDITY_ENTRY")], score: null, copyability: none, allocation: noAllocation });
    expect(result).toMatchObject({ classification: "UNKNOWN_INSUFFICIENT_EVIDENCE", earlyAccessScore: 0, reasons: ["TIMING_EVIDENCE_ONLY"] });
  });

  const withToken = (type: ClassificationEvidence["type"], tokenMint: string): ClassificationEvidence => ({ ...evidence(type), facts: { tokenMint } });

  it("uses the early-access stream only when non-public acquisition appears across enough distinct tokens", () => {
    const three = [withToken("DEPLOYER_LINKED_TRANSFER", "A"), withToken("EARLY_ALLOCATION_PATTERN", "B"), withToken("EARLY_ALLOCATION_PATTERN", "C")];
    expect(decideWalletClassification({ evidence: three, score: null, copyability: none, allocation: { nonPublicProceedsShareBps: 4000, nonPublicTokens: ["A", "B", "C"] } }).classification).toBe("EARLY_ACCESS_ALLOCATION_PATTERN");
  });

  it("does not label a wallet whose non-public inventory is a negligible share of proceeds", () => {
    const three = [withToken("EARLY_ALLOCATION_PATTERN", "A"), withToken("EARLY_ALLOCATION_PATTERN", "B"), withToken("EARLY_ALLOCATION_PATTERN", "C"), evidence("NON_COPYABLE_ENTRY"), evidence("NON_COPYABLE_ENTRY")];
    expect(decideWalletClassification({ evidence: three, score: null, copyability: none, allocation: { nonPublicProceedsShareBps: 69, nonPublicTokens: ["A", "B", "C"] } })).toMatchObject({ classification: "UNKNOWN_INSUFFICIENT_EVIDENCE", reasons: ["NON_PUBLIC_SHARE_BELOW_THRESHOLD"] });
  });

  it("accepts repeated deployer-linked receipts across distinct tokens even when the proceeds share is small", () => {
    const linked = [withToken("DEPLOYER_LINKED_TRANSFER", "A"), withToken("DEPLOYER_LINKED_TRANSFER", "B"), withToken("DEPLOYER_LINKED_TRANSFER", "C")];
    expect(decideWalletClassification({ evidence: linked, score: null, copyability: none, allocation: { nonPublicProceedsShareBps: 100, nonPublicTokens: [] } }).classification).toBe("EARLY_ACCESS_ALLOCATION_PATTERN");
  });

  it("does not label a wallet from one or two tokens of unknown origin, which may only mean incomplete history", () => {
    const two = [withToken("EARLY_ALLOCATION_PATTERN", "A"), withToken("EARLY_ALLOCATION_PATTERN", "B"), evidence("HIGH_ALLOCATION_DEPENDENCE")];
    expect(decideWalletClassification({ evidence: two, score: null, copyability: none, allocation: { nonPublicProceedsShareBps: 10_000, nonPublicTokens: ["A", "B"] } })).toMatchObject({ classification: "UNKNOWN_INSUFFICIENT_EVIDENCE", reasons: ["FEWER_THAN_3_NON_PUBLIC_TOKENS"] });
  });

  it("keeps the smart-money stream separate and requires score, copyability and low allocation dependence", () => {
    const score = scoreWallet({ completedTrades: 40, winRateBps: 7000, profitableTokenCount: 24, largestTradeProfitContributionBps: 800, maxDrawdownBps: 1000, recentProfitabilityBps: 7000, copyableTradeRatioBps: 8000, allocationProfitRatioBps: 200, dataConfidenceBps: 9500 });
    const decided = decideWalletClassification({ evidence: [], score, copyability: copyability(8000), allocation: { nonPublicProceedsShareBps: 200, nonPublicTokens: [] } });
    expect(decided.classification).toBe("COPYABLE_SMART_MONEY");
    expect(decideWalletClassification({ evidence: [], score, copyability: copyability(3000), allocation: { nonPublicProceedsShareBps: 200, nonPublicTokens: [] } }).classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
    expect(decideWalletClassification({ evidence: [], score: null, copyability: copyability(8000), allocation: noAllocation }).classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
  });

  it("never assigns a related/team-linked label without corroborated funding evidence", () => {
    expect(decideWalletClassification({ evidence: [evidence("RELATED_FUNDING_PATTERN")], score: null, copyability: none, allocation: noAllocation }).classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
  });
});
