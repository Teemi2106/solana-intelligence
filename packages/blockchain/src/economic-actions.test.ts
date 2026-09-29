import { describe, expect, it } from "vitest";
import { classifyEconomicActions, reconstructEconomicLegs, reconstructSwap, type WalletAddress } from "@swi/domain";
import { normalizeHeliusTransaction } from "./helius-provider";
import { accountCloseCanonicalEvidence, accountCloseFixture, FIXTURE_WALLET, fullExitFixture, GTA6_MINT, GTA6_RAW_POSITION, nativeTransferOutFixture } from "./fixtures";

const normalized = (fixture: typeof fullExitFixture) => normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixture);

describe("production economic-action regressions", () => {
  it("classifies 4bprMUE…X5vr2 as a deterministic 100% FULL_EXIT", () => {
    const transaction = normalized(fullExitFixture);
    const reconstruction = reconstructSwap(transaction);
    const [action] = classifyEconomicActions({
      succeeded: true, reconstructedLegs: reconstruction.legs, tokenFlows: transaction.tokenFlows,
      nativePrincipalLamports: transaction.nativeTransferLamports ?? 0n,
      positions: new Map([[GTA6_MINT, { rawAmount: GTA6_RAW_POSITION, complete: true }]]),
    });
    expect(action).toMatchObject({ action: "FULL_EXIT", tokenMint: GTA6_MINT, rawTokenAmount: GTA6_RAW_POSITION, positionBeforeRaw: GTA6_RAW_POSITION, positionAfterRaw: 0n, positionImpactNumerator: GTA6_RAW_POSITION, positionImpactDenominator: GTA6_RAW_POSITION, confidence: "HIGH" });
  });

  it("recovers deterministic economics from provider UNKNOWN without changing Phase 2", () => {
    const transaction = normalized({ ...fullExitFixture, type: "UNKNOWN" });
    const phase2 = reconstructSwap(transaction);
    const legs = reconstructEconomicLegs(transaction, phase2);
    expect(phase2.legs).toEqual([]);
    expect(legs).toMatchObject([{ side: "SELL", rawTokenAmount: GTA6_RAW_POSITION, consideration: "EXACT" }]);
  });

  it("classifies 31vcm…D2y3Be as a zero-impact ACCOUNT_CLOSE and no trade", () => {
    const transaction = normalized(accountCloseFixture);
    const reconstruction = reconstructSwap(transaction);
    const [action] = classifyEconomicActions({
      succeeded: true, reconstructedLegs: reconstruction.legs, tokenFlows: transaction.tokenFlows,
      nativePrincipalLamports: transaction.nativeTransferLamports ?? 0n, positions: new Map(), canonicalEvidence: accountCloseCanonicalEvidence,
    });
    expect(reconstruction.legs).toEqual([]);
    expect(action).toMatchObject({ action: "ACCOUNT_CLOSE", tokenMint: GTA6_MINT, rawTokenAmount: 0n, positionImpactNumerator: 0n, confidence: "HIGH" });
  });

  it("classifies 4zfLxYiu…R5WSA as native TRANSFER_OUT, never SELL", () => {
    const transaction = normalized(nativeTransferOutFixture);
    const [action] = classifyEconomicActions({
      succeeded: true, reconstructedLegs: reconstructSwap(transaction).legs, tokenFlows: transaction.tokenFlows,
      nativePrincipalLamports: transaction.nativeTransferLamports ?? 0n, positions: new Map(),
    });
    expect(action).toMatchObject({ action: "TRANSFER_OUT", tokenMint: null, rawTokenAmount: 445_722_893_198n, tokenDecimals: 9, confidence: "HIGH" });
    expect(action?.action).not.toBe("SELL");
  });
});
