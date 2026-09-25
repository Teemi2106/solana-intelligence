import { describe, expect, it } from "vitest";
import { canonicalStablecoins, jitoTipAccounts, WRAPPED_SOL_MINT } from "./assets";
import { defined } from "./invariant";
import type { HistoricalSettlementFacts, HistoricalTokenFlow, HistoricalWalletTransaction } from "./ports";
import type { TokenMint } from "./types";
import { reconstructSwap } from "./swap-economics";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN = "TokenAAAA11111111111111111111111111111111pump";
const OTHER = "TokenBBBB11111111111111111111111111111111pump";

const flow = (mint: string, direction: "IN" | "OUT", rawAmount: bigint, decimals = 6): HistoricalTokenFlow => ({ mint: mint as TokenMint, direction, rawAmount, decimals, account: null, counterparty: null });
const settlement = (overrides: Partial<HistoricalSettlementFacts> = {}): HistoricalSettlementFacts => ({
  venue: "PUMP_AMM", walletTokenAccountRentLamports: 0n, counterpartyWsolDeltaLamports: null, tipLamports: 0n, movedMints: [], ...overrides,
});
const tx = (overrides: Partial<HistoricalWalletTransaction> = {}): HistoricalWalletTransaction => ({
  signature: "sig" as HistoricalWalletTransaction["signature"], slot: 1n, occurredAt: new Date("2026-09-01T00:00:00Z"), succeeded: true, providerType: "SWAP",
  feeLamports: 5_000n, feePayerIsWallet: true, tokenFlows: [], nativeSolDeltaLamports: 0n, source: "fixture", settlement: settlement(), quality: "HIGH", issues: [], ...overrides,
});
const only = (transaction: HistoricalWalletTransaction) => {
  const result = reconstructSwap(transaction);
  expect(result.legs).toHaveLength(1);
  return defined(result.legs[0]);
};

describe("SOL and stablecoin swaps", () => {
  it("SOL -> token derives the acquisition cost from native SOL, excluding the network fee", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 42_000_000n)] }));
    expect(leg).toMatchObject({ side: "BUY", tokenMint: TOKEN, rawTokenAmount: 42_000_000n, quoteKind: "SOL", consideration: "DERIVED", feeLamports: 5_000n });
    expect(leg.quote).toEqual({ mint: WRAPPED_SOL_MINT, rawAmount: 1_000_000_000n, decimals: 9 });
    expect(leg.spent?.mint).toBe(WRAPPED_SOL_MINT);
    expect(leg.received?.mint).toBe(TOKEN);
  });

  it("token -> SOL derives disposal proceeds from native SOL, adding back the fee the wallet paid", () => {
    const leg = only(tx({ nativeSolDeltaLamports: 4_995_000n, tokenFlows: [flow(TOKEN, "OUT", 4_000_000n)] }));
    expect(leg).toMatchObject({ side: "SELL", quoteKind: "SOL" });
    expect(leg.quote?.rawAmount).toBe(5_000_000n);
  });

  it("USDC -> token uses exact stablecoin flows and ignores the SOL fee", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(USDC, "OUT", 25_000_000n), flow(TOKEN, "IN", 9_000_000_000n, 9)] }));
    expect(leg).toMatchObject({ side: "BUY", quoteKind: "STABLECOIN", consideration: "EXACT", feeLamports: 5_000n });
    expect(leg.quote).toEqual({ mint: USDC, rawAmount: 25_000_000n, decimals: 6 });
  });

  it("token -> USDC is a sell with USDC proceeds", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(TOKEN, "OUT", 9_000_000_000n, 9), flow(USDC, "IN", 31_500_000n)] }));
    expect(leg).toMatchObject({ side: "SELL", quoteKind: "STABLECOIN", consideration: "EXACT" });
    expect(leg.quote?.rawAmount).toBe(31_500_000n);
  });

  it("SOL -> USDC is a quote-to-quote swap, not a token trade", () => {
    const result = reconstructSwap(tx({ nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(USDC, "IN", 117_000_000n)] }));
    expect(result).toMatchObject({ kind: "SWAP", legs: [], issues: ["QUOTE_TO_QUOTE_SWAP"] });
  });
});

describe("wSOL normalization", () => {
  it("merges a wallet-owned wSOL account with the token flow into one SOL quote", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(WRAPPED_SOL_MINT, "OUT", 1_000_000_000n, 9), flow(TOKEN, "IN", 42_000_000n)] }));
    expect(leg).toMatchObject({ side: "BUY", wsolNormalized: true, quoteKind: "SOL", consideration: "EXACT" });
    expect(leg.quote?.rawAmount).toBe(1_000_000_000n);
  });

  it("does not double count native SOL that was wrapped into the wallet's own wSOL account", () => {
    // 1 SOL wrapped natively (-1 SOL native), then spent as wSOL (+1 -1 = 0 net wSOL): total exposure is -1 SOL.
    const leg = only(tx({ nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(WRAPPED_SOL_MINT, "IN", 1_000_000_000n, 9), flow(WRAPPED_SOL_MINT, "OUT", 1_000_000_000n, 9), flow(TOKEN, "IN", 7n)] }));
    expect(leg.quote?.rawAmount).toBe(1_000_000_000n);
  });

  it("uses the exact counterparty wSOL ledger when the wallet's temporary wSOL account nets to zero", () => {
    // Real PumpSwap buy: 3.3 SOL wrapped, swapped and the temp account closed; wallet delta = -3.3 SOL - fee.
    const leg = only(tx({
      feeLamports: 65_000n, nativeSolDeltaLamports: -3_300_065_000n, tokenFlows: [flow(TOKEN, "IN", 2_635_247_999_618n)],
      settlement: settlement({ counterpartyWsolDeltaLamports: 3_300_000_000n, movedMints: [TOKEN, WRAPPED_SOL_MINT] }),
    }));
    expect(leg).toMatchObject({ side: "BUY", wsolNormalized: true, consideration: "EXACT", unattributedLamports: 0n, routed: false });
    expect(leg.quote?.rawAmount).toBe(3_300_000_000n);
  });

  it("excludes rent the wallet funded for third-party accounts and reports it as unattributed", () => {
    const leg = only(tx({
      nativeSolDeltaLamports: -11_003_923_780n, feeLamports: 5_300n, tokenFlows: [flow(TOKEN, "IN", 6_380_253_405_420n)],
      settlement: settlement({ walletTokenAccountRentLamports: 2_074_080n, counterpartyWsolDeltaLamports: 11_000_000_000n, movedMints: [TOKEN, WRAPPED_SOL_MINT] }),
    }));
    expect(leg.quote?.rawAmount).toBe(11_000_000_000n);
    expect(leg.unattributedLamports).toBe(-1_844_400n);
    expect(leg.rentExcludedLamports).toBe(2_074_080n);
  });

  it("declares the consideration ambiguous instead of guessing when the two SOL ledgers disagree", () => {
    const result = reconstructSwap(tx({
      nativeSolDeltaLamports: -5_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 10n)],
      settlement: settlement({ counterpartyWsolDeltaLamports: 1_000_000_000n }),
    }));
    expect(result.legs[0]).toMatchObject({ side: "BUY", consideration: "AMBIGUOUS", quote: null, quoteKind: null });
    expect(result.issues).toContain("SOL_LEDGER_MISMATCH");
  });
});

describe("rent, fees and tips are never consideration", () => {
  it("excludes ATA creation rent from a buy", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -1_002_044_280n, tokenFlows: [flow(TOKEN, "IN", 5n)], settlement: settlement({ walletTokenAccountRentLamports: 2_039_280n, venue: null }) }));
    expect(leg.quote?.rawAmount).toBe(1_000_000_000n);
    expect(leg.rentExcludedLamports).toBe(2_039_280n);
  });

  it("excludes rent refunded by closing the token account after a sell", () => {
    const leg = only(tx({ nativeSolDeltaLamports: 500_000_000n + 2_039_280n - 5_000n, tokenFlows: [flow(TOKEN, "OUT", 5n)], settlement: settlement({ walletTokenAccountRentLamports: -2_039_280n }) }));
    expect(leg).toMatchObject({ side: "SELL", rentExcludedLamports: -2_039_280n });
    expect(leg.quote?.rawAmount).toBe(500_000_000n);
  });

  it("treats a temporary wSOL account created and closed in the transaction as neutral", () => {
    // Rent of the temp wSOL account leaves and returns; only the principal shows up in the wallet delta.
    const leg = only(tx({ nativeSolDeltaLamports: 192_852_934_409n, feeLamports: 65_000n, tokenFlows: [flow(TOKEN, "OUT", 96_564_583_244_185n)], settlement: settlement({ counterpartyWsolDeltaLamports: -192_852_999_409n }) }));
    expect(leg.quote?.rawAmount).toBe(192_852_999_409n);
    expect(leg.consideration).toBe("EXACT");
  });

  it("reports the network fee separately, including a priority fee, without changing consideration", () => {
    const base = only(tx({ feeLamports: 5_000n, nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 1n)] }));
    const priority = only(tx({ feeLamports: 1_005_000n, nativeSolDeltaLamports: -1_001_005_000n, tokenFlows: [flow(TOKEN, "IN", 1n)] }));
    expect(base.quote?.rawAmount).toBe(priority.quote?.rawAmount);
    expect(priority).toMatchObject({ feeLamports: 1_005_000n, networkFeeLamports: 1_005_000n });
  });

  it("does not deduct a fee the wallet did not pay", () => {
    const leg = only(tx({ feePayerIsWallet: false, nativeSolDeltaLamports: -1_000_000_000n, tokenFlows: [flow(TOKEN, "IN", 1n)] }));
    expect(leg).toMatchObject({ feeLamports: 0n });
    expect(leg.quote?.rawAmount).toBe(1_000_000_000n);
  });

  it("separates bundle tips from consideration and counts them as execution cost", () => {
    expect(jitoTipAccounts.size).toBe(8);
    const leg = only(tx({ nativeSolDeltaLamports: -1_100_005_000n, tokenFlows: [flow(TOKEN, "IN", 1n)], settlement: settlement({ tipLamports: 100_000_000n }) }));
    expect(leg.quote?.rawAmount).toBe(1_000_000_000n);
    expect(leg).toMatchObject({ tipLamports: 100_000_000n, networkFeeLamports: 5_000n, feeLamports: 100_005_000n });
  });
});

describe("routed swaps", () => {
  it("treats SOL -> A -> B -> TOKEN as SOL -> TOKEN and lists the route assets", () => {
    const leg = only(tx({
      nativeSolDeltaLamports: -2_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 77n)],
      settlement: settlement({ venue: "JUPITER", movedMints: [TOKEN, USDC, OTHER, WRAPPED_SOL_MINT] }),
    }));
    expect(leg).toMatchObject({ side: "BUY", routed: true, routeAssets: [OTHER, USDC].sort(), quoteKind: "SOL" });
    expect(leg.quote?.rawAmount).toBe(2_000_000_000n);
  });

  it("does not turn intermediates the wallet momentarily holds into trades", () => {
    const result = reconstructSwap(tx({
      nativeSolDeltaLamports: -1_000_005_000n,
      tokenFlows: [flow(USDC, "IN", 117_000_000n), flow(USDC, "OUT", 117_000_000n), flow(TOKEN, "IN", 5n)],
      settlement: settlement({ venue: "JUPITER", movedMints: [TOKEN, USDC] }),
    }));
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ tokenMint: TOKEN, quoteKind: "SOL", routed: true, routeAssets: [USDC] });
  });

  it("treats TOKEN -> route assets -> SOL as a sell with the wallet's actual proceeds", () => {
    const leg = only(tx({
      nativeSolDeltaLamports: 3_000_000_000n - 5_000n, tokenFlows: [flow(TOKEN, "OUT", 10n)],
      settlement: settlement({ venue: "JUPITER", movedMints: [TOKEN, OTHER, WRAPPED_SOL_MINT] }),
    }));
    expect(leg).toMatchObject({ side: "SELL", routed: true, routeAssets: [OTHER] });
    expect(leg.quote?.rawAmount).toBe(3_000_000_000n);
  });

  it("is not routed when only the token and its wSOL rail moved", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 1n)], settlement: settlement({ movedMints: [TOKEN, WRAPPED_SOL_MINT] }) }));
    expect(leg.routed).toBe(false);
    expect(leg.routeAssets).toEqual([]);
  });
});

describe("unknown quote assets and safety", () => {
  it("keeps a token-for-token swap as a disposal and an acquisition with unknown quote assets", () => {
    const result = reconstructSwap(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(TOKEN, "OUT", 100n), flow(OTHER, "IN", 900n)] }));
    expect(result.legs.map((leg) => [leg.side, leg.tokenMint, leg.quoteKind])).toEqual([["SELL", TOKEN, null], ["BUY", OTHER, null]]);
    expect(result.issues).toContain("UNKNOWN_QUOTE_ASSET");
    // The network fee is attributed once, to the disposal.
    expect(result.legs.map((leg) => leg.feeLamports)).toEqual([5_000n, 0n]);
  });

  it("never classifies an arbitrary token or a wrong-decimals mint as a stablecoin", () => {
    const spoof = reconstructSwap(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow("USDCFake1111111111111111111111111111111111", "OUT", 25_000_000n), flow(TOKEN, "IN", 1n)] }));
    expect(spoof.legs.map((leg) => leg.quoteKind)).toEqual([null, null]);
    const wrongDecimals = reconstructSwap(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(USDC, "OUT", 25n, 9), flow(TOKEN, "IN", 1n)] }));
    expect(wrongDecimals.legs.map((leg) => leg.quoteKind)).toEqual([null, null]);
    expect([...canonicalStablecoins.keys()]).toContain(USDC);
  });

  it("keeps a lone token flow as a trade with unknown consideration", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -5_000n, tokenFlows: [flow(TOKEN, "IN", 5n)] }));
    expect(leg).toMatchObject({ side: "BUY", quote: null, consideration: "AMBIGUOUS" });
  });

  it("nets routed token flows before identifying a buy", () => {
    const leg = only(tx({ nativeSolDeltaLamports: -1_000_005_000n, tokenFlows: [flow(TOKEN, "IN", 20n), flow(TOKEN, "OUT", 5n)] }));
    expect(leg).toMatchObject({ side: "BUY", rawTokenAmount: 15n });
  });

  it("excludes failed transactions, transfers and multi-asset residuals", () => {
    expect(reconstructSwap(tx({ succeeded: false })).legs).toEqual([]);
    expect(reconstructSwap(tx({ providerType: "TRANSFER", tokenFlows: [flow(TOKEN, "IN", 1n)] }))).toMatchObject({ kind: "TRANSFER" });
    expect(reconstructSwap(tx({ nativeSolDeltaLamports: -1_005_000n, tokenFlows: [flow(TOKEN, "IN", 1n), flow(OTHER, "IN", 1n)] }))).toMatchObject({ kind: "AMBIGUOUS", issues: ["AMBIGUOUS_MULTI_ASSET_FLOW"] });
    expect(reconstructSwap(tx({ nativeSolDeltaLamports: -5_000n }))).toMatchObject({ kind: "AMBIGUOUS", issues: ["NO_WALLET_TOKEN_FLOW"] });
  });

  it("rejects conflicting decimals for one mint", () => {
    expect(reconstructSwap(tx({ tokenFlows: [flow(TOKEN, "IN", 1n, 6), flow(TOKEN, "OUT", 1n, 9)] }))).toMatchObject({ kind: "AMBIGUOUS", issues: ["CONFLICTING_TOKEN_DECIMALS"] });
  });

  it("separates wallet-paid fees from a small sale's SOL proceeds", () => {
    const leg = only(tx({ feeLamports: 65_000n, nativeSolDeltaLamports: -60_656n, tokenFlows: [flow(TOKEN, "OUT", 4_000_000n)] }));
    expect(leg).toMatchObject({ side: "SELL" });
    expect(leg.quote?.rawAmount).toBe(4_344n);
  });
});
