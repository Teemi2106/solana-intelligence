import { describe, expect, it } from "vitest";
import type { EconomicAction } from "@swi/domain";
import { liveActivityMessage } from "./live-handlers.js";

const base = { walletAddress: "GatgyE2SqnNNjNeNGR8MG1VSVxFGxgyjB111hYJRTkee", transactionType: "UNKNOWN", signature: "4bprMUEiN1vaZpNXxExeQRGSzLY98CtDUaM4thChKMSx1qtiSPumwv3WSpirtMe1PuAtCp8KQD2D71A2kNjX5vr2", occurredAt: new Date("2026-09-28T12:10:26Z") };

describe("live economic-action messages", () => {
  it("renders deterministic full-exit evidence without promoting provider type", () => {
    const action: EconomicAction = {
      action: "FULL_EXIT", tokenMint: "CHyPGNd9d7enSG9MiFfbLaYN7PcP8Z7V4Jp2RH73pump", rawTokenAmount: 25_659_509_885_469n, tokenDecimals: 6,
      consideration: { mint: "So11111111111111111111111111111111111111112", rawAmount: 399_123_558_197n, decimals: 9 },
      positionBeforeRaw: 25_659_509_885_469n, positionAfterRaw: 0n, positionImpactNumerator: 25_659_509_885_469n, positionImpactDenominator: 25_659_509_885_469n,
      confidence: "HIGH", evidence: ["DETERMINISTIC_RECONSTRUCTED_SELL", "COMPLETE_PRE_TRANSACTION_POSITION"],
    };
    const message = liveActivityMessage({ ...base, economicActions: [action] });
    expect(message).toContain("🔴 FULL EXIT");
    expect(message).toContain("Position affected: 100.00%");
    expect(message).toContain("Remaining tracked position: 0");
    expect(message).toContain("Provider type: UNKNOWN (provenance)");
  });
});
