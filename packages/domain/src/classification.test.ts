import { describe, expect, it } from "vitest";
import { classifyWallet, type ClassificationEvidence } from "./classification";

const evidence = (type: ClassificationEvidence["type"], confidenceBps = 8000): ClassificationEvidence => ({ type, confidenceBps, observedAt: new Date("2026-01-01T00:00:00Z"), facts: { source: "fixture" } });

describe("wallet classification", () => {
  it("requires persisted evidence and keeps early-access separate", () => {
    expect(classifyWallet([]).classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
    const result = classifyWallet([evidence("PRE_LAUNCH_RECIPIENT"), evidence("DEPLOYER_LINKED_TRANSFER")]);
    expect(result.classification).toBe("EARLY_ACCESS_ALLOCATION_PATTERN");
    expect(result.earlyAccessScore).toBeGreaterThan(0);
  });

  it("does not infer ownership from one funding observation", () => {
    expect(classifyWallet([evidence("RELATED_FUNDING_PATTERN")]).classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
  });
});
