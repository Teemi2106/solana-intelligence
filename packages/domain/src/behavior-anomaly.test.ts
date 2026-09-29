import { describe, expect, it } from "vitest";
import { actionNgrams, baselineQuality, deriveIncidentSeverity, empiricalPercentile, holdingDurationSemanticSourceId, numericStatistics } from "./behavior-anomaly";

describe("behavior anomaly policy", () => {
  it("encodes FIFO realization provenance canonically without floating point", () => {
    const input = { walletId: "wallet", tokenId: "token", sellTradeId: "sell", acquisitionTradeId: "buy", realizedRawAmount: "000123" };
    expect(holdingDurationSemanticSourceId(input)).toBe("fifo-v1|wallet=wallet|token=token|sell=sell|acquisition=buy|raw=123");
    expect(holdingDurationSemanticSourceId({ ...input, realizedRawAmount: 123n })).toBe(holdingDurationSemanticSourceId(input));
    expect(() => holdingDurationSemanticSourceId({ ...input, realizedRawAmount: "0" })).toThrow("REALIZED_RAW_AMOUNT_MUST_BE_POSITIVE");
  });

  it("computes deterministic decimal-safe robust statistics, including zero MAD", () => {
    expect(numericStatistics(["0.1", "0.2", "0.3", "1000000000000000000.4"])).toEqual({
      count: 4, minimum: "0.1", q1: "0.175", median: "0.25", q3: "250000000000000000.325", maximum: "1000000000000000000.4", mad: "0.1",
    });
    expect(numericStatistics(["7", "7", "7", "7"])?.mad).toBe("0");
  });

  it("suppresses percentile claims below the minimum sample size", () => {
    expect(empiricalPercentile("100", Array.from({ length: 19 }, (_, index) => String(index)))).toBeNull();
    expect(empiricalPercentile("100", Array.from({ length: 20 }, (_, index) => String(index)))).toEqual({ lowerBps: 10_000, upperBps: 10_000 });
  });

  it("applies history, count, coverage, and completeness quality gates", () => {
    expect(baselineQuality({ count: 1_000, coverageDays: 180, historyComplete: false })).toBe("INSUFFICIENT");
    expect(baselineQuality({ count: 19, coverageDays: 180, historyComplete: true })).toBe("INSUFFICIENT");
    expect(baselineQuality({ count: 20, coverageDays: 14, historyComplete: true })).toBe("LOW");
    expect(baselineQuality({ count: 50, coverageDays: 30, historyComplete: true, completenessBps: 8_000 })).toBe("MEDIUM");
    expect(baselineQuality({ count: 200, coverageDays: 90, historyComplete: true, completenessBps: 9_500 })).toBe("HIGH");
  });

  it("encodes action sequences with deterministic time-gap buckets", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    const actions = [
      { action: "FULL_EXIT", occurredAt: start },
      { action: "ACCOUNT_CLOSE", occurredAt: new Date(start.getTime() + 10 * 60_000) },
      { action: "TRANSFER_OUT", occurredAt: new Date(start.getTime() + 40 * 60_000) },
    ];
    expect(actionNgrams(actions, 3)).toEqual(["FULL_EXIT→GT_5M_LE_30M:ACCOUNT_CLOSE→GT_5M_LE_30M:TRANSFER_OUT"]);
  });

  it("derives severity transparently and suppresses duplicate-family inflation", () => {
    expect(deriveIncidentSeverity([{ family: "EXIT", tier: "NOTABLE", baselineQuality: "LOW" }, { family: "EXIT", tier: "NOTABLE", baselineQuality: "HIGH" }]).severity).toBe("NOTABLE");
    expect(deriveIncidentSeverity([{ family: "EXIT", tier: "NOTABLE", baselineQuality: "LOW" }, { family: "TRANSFER", tier: "NOTABLE", baselineQuality: "LOW" }])).toMatchObject({ severity: "UNUSUAL", ruleIds: ["SEVERITY_V1_TWO_INDEPENDENT_NOTABLE_FAMILIES"] });
    expect(deriveIncidentSeverity([{ family: "SEQUENCE", tier: "EXTREME", baselineQuality: "INSUFFICIENT" }]).severity).toBeNull();
  });

  it("keeps the sanitized GTA sequence descriptive when its wallet baseline is insufficient", () => {
    const result = deriveIncidentSeverity([
      { family: "EXIT", tier: "EXTREME", baselineQuality: "INSUFFICIENT" },
      { family: "SEQUENCE", tier: "EXTREME", baselineQuality: "INSUFFICIENT" },
      { family: "TRANSFER", tier: "EXTREME", baselineQuality: "INSUFFICIENT" },
    ]);
    expect(result).toEqual({ severity: null, ruleIds: [], families: [] });
  });

  it("allows the GTA sequence to become anomalous only through sufficient wallet-specific facts", () => {
    const result = deriveIncidentSeverity([
      { family: "EXIT", tier: "UNUSUAL", baselineQuality: "MEDIUM" },
      { family: "SEQUENCE", tier: "NOTABLE", baselineQuality: "MEDIUM" },
      { family: "TRANSFER", tier: "UNUSUAL", baselineQuality: "HIGH" },
    ]);
    expect(result).toMatchObject({ severity: "EXTREME", ruleIds: ["SEVERITY_V1_TWO_INDEPENDENT_UNUSUAL_FAMILIES"], families: ["EXIT", "SEQUENCE", "TRANSFER"] });
  });
});
