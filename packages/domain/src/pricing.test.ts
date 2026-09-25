import { describe, expect, it } from "vitest";
import { WRAPPED_SOL_MINT } from "./assets";
import type { HistoricalPriceObservation, HistoricalPriceResult } from "./historical-price";
import { priceRequestsFor, priceTrade, type TradeForPricing } from "./pricing";

const at = new Date("2026-09-01T12:00:30Z");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const observation = (asset: string, priceUsd: string, confidenceBps = 9500): HistoricalPriceResult => ({
  status: "FOUND",
  observation: { asset, requestedAt: at, observedAt: new Date("2026-09-01T12:00:00Z"), priceUsd, provider: "test-provider", granularitySeconds: 60, confidenceBps, observationId: `obs-${asset}` } satisfies HistoricalPriceObservation,
});
const trade = (overrides: Partial<TradeForPricing> = {}): TradeForPricing => ({
  side: "BUY", tokenMint: "TOKEN", rawTokenAmount: 1_000_000n, tokenDecimals: 6, quote: { mint: WRAPPED_SOL_MINT, rawAmount: 2_000_000_000n, decimals: 9 },
  quoteKind: "SOL", consideration: "EXACT", feeLamports: 5_000n, occurredAt: at, ...overrides,
});
const solAt = (price: string) => (request: { asset: string }) => (request.asset === WRAPPED_SOL_MINT ? observation(WRAPPED_SOL_MINT, price) : undefined);

describe("trade pricing hierarchy", () => {
  it("prices a stablecoin flow directly, without any market price", () => {
    const pricing = priceTrade(trade({ quote: { mint: USDC, rawAmount: 25_000_000n, decimals: 6 }, quoteKind: "STABLECOIN", feeLamports: 0n }), () => undefined);
    expect(pricing).toMatchObject({ state: "PRICED_FROM_STABLECOIN_FLOW", basis: "EXACT", considerationUsd: "25", executionPriceUsd: "25", executionPriceQuote: "25", feeUsd: "0", quoteUsdPrice: "1" });
    expect(pricing.confidenceBps).toBe(9900);
  });

  it("prices a SOL flow from the swap's own lamports and the timestamped SOL/USD", () => {
    const pricing = priceTrade(trade(), solAt("100"));
    expect(pricing).toMatchObject({ state: "PRICED_FROM_SOL_FLOW", basis: "DERIVED", considerationUsd: "200", executionPriceQuote: "2", executionPriceUsd: "200", quoteUsdPrice: "100", priceObservationId: "obs-So11111111111111111111111111111111111111112" });
    expect(pricing.source).toBe("SOL_FLOW:test-provider");
    expect(pricing.feeUsd).toBe("0.0005");
    expect(pricing.pricedAt).toEqual(new Date("2026-09-01T12:00:00Z"));
  });

  it("lowers confidence when the SOL leg itself was only derived from the native ledger", () => {
    const exact = priceTrade(trade({ consideration: "EXACT" }), solAt("100"));
    const derived = priceTrade(trade({ consideration: "DERIVED" }), solAt("100"));
    expect(derived.confidenceBps).toBeLessThan(exact.confidenceBps ?? 0);
  });

  it("keeps the trade but reports MISSING_QUOTE_USD_PRICE when SOL/USD is unavailable", () => {
    const pricing = priceTrade(trade(), () => ({ status: "NOT_AVAILABLE", asset: WRAPPED_SOL_MINT, requestedAt: at, provider: "test-provider", reason: "NO_CANDLE_WITHIN_5_MINUTES" }));
    expect(pricing).toMatchObject({ state: "MISSING_QUOTE_USD_PRICE", basis: "UNAVAILABLE", considerationUsd: null, executionPriceUsd: null, executionPriceQuote: "2" });
    expect(pricing.issues).toContain("SOL_USD_NOT_AVAILABLE");
  });

  it("treats a provider timeout as a missing SOL/USD price, not a zero", () => {
    const pricing = priceTrade(trade(), () => ({ status: "ERROR", asset: WRAPPED_SOL_MINT, requestedAt: at, provider: "test-provider", reason: "TIMEOUT_OR_NETWORK" }));
    expect(pricing.state).toBe("MISSING_QUOTE_USD_PRICE");
    expect(pricing.issues).toContain("SOL_USD_ERROR");
  });

  it("prices a stablecoin trade even when SOL/USD is missing, but marks the fee unknown", () => {
    const pricing = priceTrade(trade({ quote: { mint: USDC, rawAmount: 25_000_000n, decimals: 6 }, quoteKind: "STABLECOIN" }), () => undefined);
    expect(pricing).toMatchObject({ state: "PRICED_FROM_STABLECOIN_FLOW", feeUsd: null });
    expect(pricing.issues).toContain("FEE_USD_UNKNOWN");
  });

  it("does not invent a price for an unknown long-tail quote asset", () => {
    const pricing = priceTrade(trade({ quote: { mint: "LongTailQuote", rawAmount: 5n, decimals: 6 }, quoteKind: null, feeLamports: 0n }), () => ({ status: "UNSUPPORTED", asset: "x", requestedAt: at, provider: "router", reason: "NO_PROVIDER_COVERS_ASSET" }));
    expect(pricing).toMatchObject({ state: "MISSING_HISTORICAL_PRICE", basis: "UNAVAILABLE", considerationUsd: null });
    expect(pricing.issues).toEqual(expect.arrayContaining(["UNKNOWN_QUOTE_ASSET", "QUOTE_PRICE_UNSUPPORTED"]));
  });

  it("uses external history for an unknown quote asset only when a provider actually has it", () => {
    const pricing = priceTrade(trade({ quote: { mint: "KnownQuote", rawAmount: 4_000_000n, decimals: 6 }, quoteKind: null, feeLamports: 0n }), (request) => (request.asset === "KnownQuote" ? observation("KnownQuote", "2.5") : undefined));
    expect(pricing).toMatchObject({ state: "PRICED_FROM_EXTERNAL_HISTORY", basis: "EXTERNAL", considerationUsd: "10", source: "EXTERNAL_QUOTE:test-provider" });
  });

  it("caps confidence when only the token's own benchmark price is available", () => {
    const pricing = priceTrade(trade({ quote: { mint: "LongTailQuote", rawAmount: 4_000_000n, decimals: 6 }, quoteKind: null, feeLamports: 0n }), (request) => (request.asset === "TOKEN" ? observation("TOKEN", "3") : undefined));
    expect(pricing).toMatchObject({ state: "PRICED_FROM_EXTERNAL_HISTORY", considerationUsd: "3" });
    expect(pricing.confidenceBps).toBeLessThanOrEqual(6000);
    expect(pricing.issues).toContain("VALUED_FROM_TOKEN_PRICE_NOT_FLOW");
  });

  it("flags unknown consideration as AMBIGUOUS_CONSIDERATION and never prices it", () => {
    expect(priceTrade(trade({ quote: null, quoteKind: null, consideration: "AMBIGUOUS" }), solAt("100"))).toMatchObject({ state: "AMBIGUOUS_CONSIDERATION", considerationUsd: null });
  });

  it("uses decimal arithmetic with tiny long-tail prices", () => {
    const pricing = priceTrade(trade({ rawTokenAmount: 123_456_789_012_345n, tokenDecimals: 6, quote: { mint: WRAPPED_SOL_MINT, rawAmount: 1_000_000_007n, decimals: 9 }, feeLamports: 0n }), solAt("117.123456"));
    expect(pricing.executionPriceQuote).toBe("0.000000008100000129600045716401");
    expect(pricing.considerationUsd).toBe("117.123456819864192");
  });

  it("is deterministic for identical inputs", () => {
    expect(priceTrade(trade(), solAt("100"))).toEqual(priceTrade(trade(), solAt("100")));
  });
});

describe("price requests", () => {
  it("asks only for SOL/USD when the quote is SOL, and dedupes by caller", () => {
    expect(priceRequestsFor(trade())).toEqual([{ asset: WRAPPED_SOL_MINT, at }]);
  });
  it("asks for nothing when consideration is ambiguous", () => {
    expect(priceRequestsFor(trade({ quote: null, quoteKind: null, consideration: "AMBIGUOUS" }))).toEqual([]);
  });
  it("asks for quote and token prices for unknown quote assets", () => {
    expect(priceRequestsFor(trade({ quote: { mint: "Q", rawAmount: 1n, decimals: 6 }, quoteKind: null, feeLamports: 0n })).map((request) => request.asset)).toEqual(["Q", "TOKEN"]);
  });
  it("does not need SOL/USD for a fee-free stablecoin trade", () => {
    expect(priceRequestsFor(trade({ quote: { mint: USDC, rawAmount: 1n, decimals: 6 }, quoteKind: "STABLECOIN", feeLamports: 0n }))).toEqual([]);
  });
});
