import { describe, expect, it, vi } from "vitest";
import { WRAPPED_SOL_MINT } from "@swi/domain";
import { CoinbaseSolUsdProvider } from "./coinbase-provider.js";

const minuteOf = (iso: string) => Math.floor(Date.parse(iso) / 60_000);
const sol = (iso: string) => ({ asset: WRAPPED_SOL_MINT, at: new Date(iso) });

/** Fake Coinbase: serves the candles inside the requested [start, end] window. */
function fakeCoinbase(opens: ReadonlyMap<number, number>) {
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const start = Date.parse(url.searchParams.get("start") ?? "") / 60_000;
    const end = Date.parse(url.searchParams.get("end") ?? "") / 60_000;
    const rows = [...opens].filter(([minute]) => minute >= start && minute <= end).map(([minute, open]) => [minute * 60, open - 1, open + 1, open, open + 0.5, 10]);
    return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  });
}
const make = (request: typeof fetch, extra: ConstructorParameters<typeof CoinbaseSolUsdProvider>[0] = {}) => new CoinbaseSolUsdProvider({ fetch: request, sleep: () => Promise.resolve(), now: () => 0, ...extra });

describe("CoinbaseSolUsdProvider", () => {
  it("uses the open of the candle containing the timestamp, as an exact decimal string", async () => {
    const provider = make(fakeCoinbase(new Map([[minuteOf("2026-09-01T12:00:00Z"), 117.14]])));
    const [result] = await provider.getPrices([sol("2026-09-01T12:00:41Z")]);
    expect(result).toMatchObject({ status: "FOUND", observation: { priceUsd: "117.14", provider: "coinbase-exchange", granularitySeconds: 60, confidenceBps: 9500, observedAt: new Date("2026-09-01T12:00:00Z") } });
  });

  it("bridges a short gap with the previous candle at lower confidence and refuses long gaps", async () => {
    const provider = make(fakeCoinbase(new Map([[minuteOf("2026-09-01T12:00:00Z"), 100]])));
    const [near, far] = await provider.getPrices([sol("2026-09-01T12:03:10Z"), sol("2026-09-01T12:30:00Z")]);
    expect(near).toMatchObject({ status: "FOUND", observation: { priceUsd: "100", confidenceBps: 9000, observedAt: new Date("2026-09-01T12:00:00Z") } });
    expect(far).toMatchObject({ status: "NOT_AVAILABLE", reason: "NO_CANDLE_WITHIN_5_MINUTES" });
  });

  it("batches requests that fall into the same window into one upstream call", async () => {
    const request = fakeCoinbase(new Map([[minuteOf("2026-09-01T12:00:00Z"), 100], [minuteOf("2026-09-01T12:10:00Z"), 101], [minuteOf("2026-09-02T12:00:00Z"), 102]]));
    const results = await make(request).getPrices([sol("2026-09-01T12:00:10Z"), sol("2026-09-01T12:10:10Z"), sol("2026-09-02T12:00:10Z")]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(results.map((result) => (result.status === "FOUND" ? result.observation.priceUsd : result.status))).toEqual(["100", "101", "102"]);
  });

  it("does not cover long-tail tokens and never calls upstream for them", async () => {
    const request = fakeCoinbase(new Map());
    const [result] = await make(request).getPrices([{ asset: "LongTailMint", at: new Date("2026-09-01T12:00:00Z") }]);
    expect(result).toMatchObject({ status: "UNSUPPORTED" });
    expect(request).not.toHaveBeenCalled();
  });

  it("reports a bounded number of retries on timeout as a transient ERROR", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const [result] = await make(request, { maxAttempts: 3 }).getPrices([sol("2026-09-01T12:00:00Z")]);
    expect(result).toMatchObject({ status: "ERROR", reason: "TIMEOUT_OR_NETWORK" });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("retries a 429 honoring retry-after and then succeeds", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const ok = new Response(JSON.stringify([[minuteOf("2026-09-01T12:00:00Z") * 60, 1, 3, 2, 2, 1]]), { status: 200 });
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "2" } })).mockResolvedValueOnce(ok);
    const [result] = await make(request, { sleep }).getPrices([sol("2026-09-01T12:00:00Z")]);
    expect(result?.status).toBe("FOUND");
    expect(request).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it("does not retry a malformed response or a client error", async () => {
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "nope" }), { status: 200 }));
    expect((await make(malformed).getPrices([sol("2026-09-01T12:00:00Z")]))[0]).toMatchObject({ status: "ERROR", reason: "INVALID_RESPONSE" });
    expect(malformed).toHaveBeenCalledTimes(1);
    const rejected = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 400 }));
    expect((await make(rejected).getPrices([sol("2026-09-01T12:00:00Z")]))[0]).toMatchObject({ status: "ERROR", reason: "HTTP_400" });
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("spaces upstream requests by the configured minimum interval", async () => {
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>().mockResolvedValue(undefined);
    const request = fakeCoinbase(new Map());
    await make(request, { sleep, minIntervalMs: 350 }).getPrices([sol("2026-09-01T12:00:00Z"), sol("2026-09-02T12:00:00Z"), sol("2026-09-03T12:00:00Z")]);
    expect(request).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([350, 700]);
  });
});
