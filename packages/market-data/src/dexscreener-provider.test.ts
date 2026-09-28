import { describe, expect, it, vi } from "vitest";
import { DexScreenerRequestError, DexScreenerTokenPoolProvider } from "./dexscreener-provider.js";

const mint = "Mint111111111111111111111111111111111111111";
const quote = "Quote11111111111111111111111111111111111111";
const body = `[{
  "chainId":"solana","dexId":"raydium","pairAddress":"Pair11111111111111111111111111111111111111",
  "baseToken":{"address":"${mint}"},"quoteToken":{"address":"${quote}"},
  "priceUsd":"0.000000000000000001","priceNative":"0.000000000000000002",
  "liquidity":{"usd":12345678901234567890.123456789012345678,"base":3,"quote":4},
  "volume":{"h24":999999999999999999.000000000000000001},"txns":{"h24":{"buys":7,"sells":8}},
  "fdv":123456789012345678901234567890,"marketCap":null,"pairCreatedAt":1780000000000
}]`;

describe("DexScreenerTokenPoolProvider", () => {
  it("retains provider financial numbers losslessly and returns pool provenance", async () => {
    const provider = new DexScreenerTokenPoolProvider({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)), now: () => new Date("2026-09-28T00:00:00Z"), sleep: () => Promise.resolve(), minIntervalMs: 0 });
    const result = (await provider.getMarkets([mint])).get(mint);
    expect(result).toMatchObject({ status: "AVAILABLE", data: { pools: [{
      liquidityUsd: "12345678901234567890.123456789012345678",
      volumeH24Usd: "999999999999999999.000000000000000001",
      fdvUsd: "123456789012345678901234567890",
    }] } });
  });

  it("rejects malformed responses without partial normalization", async () => {
    const provider = new DexScreenerTokenPoolProvider({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("[{\"chainId\":\"solana\"}]")), sleep: () => Promise.resolve(), minIntervalMs: 0, maxAttempts: 1 });
    await expect(provider.getMarkets([mint])).rejects.toBeInstanceOf(DexScreenerRequestError);
  });

  it("bounds rate-limit retries and exposes a retryable sanitized code", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 429 }));
    const provider = new DexScreenerTokenPoolProvider({ fetch: request, sleep: () => Promise.resolve(), minIntervalMs: 0, maxAttempts: 2 });
    await expect(provider.getMarkets([mint])).rejects.toMatchObject({ code: "RATE_LIMITED", retryable: true });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
