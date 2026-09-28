import { describe, expect, it } from "vitest";
import { aggregateHolderEvidence, aggregateTokenMarket, type TokenPoolObservation } from "./token-intelligence.js";

const pool = (address: string, liquidityUsd: string | null, volumeH24Usd = "0"): TokenPoolObservation => ({
  poolAddress: address, dex: "dex", labels: [], baseMint: "mint", quoteMint: "quote", priceUsd: "1", priceNative: "2",
  liquidityUsd, baseLiquidity: null, quoteLiquidity: null, volumeH1Usd: null, volumeH6Usd: null, volumeH24Usd,
  h1Buys: null, h1Sells: null, h24Buys: null, h24Sells: null, fdvUsd: "100", marketCapUsd: "90", pairCreatedAt: null,
});

describe("token market evidence", () => {
  it("selects the deepest pool and aggregates unique usable pools with decimal arithmetic", () => {
    const result = aggregateTokenMarket({ mint: "mint", pools: [pool("b", "10.000000000000000001", "3.2"), pool("a", "30.000000000000000009", "4.1"), pool("a", "999"), pool("bad", null)] });
    expect(result).toMatchObject({ representativePoolAddress: "a", totalLiquidityUsd: "40.00000000000000001", largestPoolLiquidityUsd: "30.000000000000000009", largestPoolShareBps: 7500, usablePoolCount: 2, excludedPoolCount: 1, volume24hUsd: "7.3" });
  });

  it("does not turn missing liquidity into zero", () => {
    expect(aggregateTokenMarket({ mint: "mint", pools: [pool("x", null)] })).toMatchObject({ totalLiquidityUsd: null, representativePoolAddress: null, usablePoolCount: 0 });
  });
});

describe("bounded holder evidence", () => {
  it("aggregates owners without claiming complete enumeration and handles very large raw amounts", () => {
    const result = aggregateHolderEvidence({
      mint: "mint", rawSupply: 10n ** 30n, sourceAccountLimit: 20, enumerationComplete: false,
      owners: [
        { owner: "a", rawAmount: 4n * 10n ** 29n, tokenAccountCount: 2, classification: "UNCLASSIFIED", classificationEvidence: [] },
        { owner: "b", rawAmount: 1n * 10n ** 29n, tokenAccountCount: 1, classification: "PROGRAM_CONTROLLED", classificationEvidence: ["x"] },
      ],
    });
    expect(result).toMatchObject({ enumeratedOwnerCount: 2, supplyCoverageBps: 5000, top1ConcentrationBps: 4000, top10ConcentrationBps: 5000, enumerationComplete: false });
  });
});
