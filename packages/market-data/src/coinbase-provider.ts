import { WRAPPED_SOL_MINT, type HistoricalPriceProvider, type HistoricalPriceRequest, type HistoricalPriceResult } from "@swi/domain";
import { z } from "zod";
import { MinIntervalLimiter } from "./rate-limiter.js";

const candles = z.array(z.tuple([z.number().int(), z.number(), z.number(), z.number(), z.number(), z.number()]).rest(z.unknown()));

export interface CoinbaseSolUsdOptions {
  readonly fetch?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  /** Minimum spacing between upstream requests. Coinbase public limits are far higher; this stays conservative. */
  readonly minIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

const MINUTE = 60;
/** 240 one-minute candles per fetch plus a 5-minute look-back, comfortably below the 300-candle response cap. */
const CHUNK_MINUTES = 240;
const LOOKBACK_MINUTES = 5;

const failed = (request: HistoricalPriceRequest, reason: string): HistoricalPriceResult => ({ status: "ERROR", asset: request.asset, requestedAt: request.at, provider: "coinbase-exchange", reason });

/**
 * SOL/USD from Coinbase Exchange one-minute candles (public market-data endpoint, no key).
 *
 * The price used for a request is the OPEN of the one-minute candle containing the timestamp. If that
 * minute printed no trades, the most recent earlier candle within five minutes is used and the
 * confidence is lowered. Anything older is reported as NOT_AVAILABLE, never guessed.
 *
 * It intentionally supports SOL only: long-tail Solana tokens have no reliable historical price here.
 */
export class CoinbaseSolUsdProvider implements HistoricalPriceProvider {
  readonly name = "coinbase-exchange";
  readonly granularitySeconds = MINUTE;
  private readonly request: typeof fetch;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly limiter: MinIntervalLimiter;

  constructor(options: CoinbaseSolUsdOptions = {}) {
    this.request = options.fetch ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.exchange.coinbase.com";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.limiter = new MinIntervalLimiter(options.minIntervalMs ?? 350, this.sleep, options.now ?? Date.now);
  }

  supports(asset: string): boolean {
    return asset === WRAPPED_SOL_MINT;
  }

  async getPrices(requests: readonly HistoricalPriceRequest[]): Promise<readonly HistoricalPriceResult[]> {
    const results = new Array<HistoricalPriceResult>(requests.length);
    const chunks = new Map<number, number[]>();
    requests.forEach((request, index) => {
      if (!this.supports(request.asset)) {
        results[index] = { status: "UNSUPPORTED", asset: request.asset, requestedAt: request.at, provider: this.name, reason: "ASSET_NOT_COVERED" };
        return;
      }
      const chunk = Math.floor(Math.floor(request.at.getTime() / 1000 / MINUTE) / CHUNK_MINUTES);
      chunks.set(chunk, [...(chunks.get(chunk) ?? []), index]);
    });

    for (const [chunk, indexes] of [...chunks].sort(([a], [b]) => a - b)) {
      const firstMinute = chunk * CHUNK_MINUTES;
      const from = (firstMinute - LOOKBACK_MINUTES) * MINUTE;
      const to = (firstMinute + CHUNK_MINUTES - 1) * MINUTE;
      const fetched = await this.fetchCandles(from, to);
      for (const index of indexes) {
        const request = requests[index];
        if (!request) continue;
        if (typeof fetched === "string") {
          results[index] = failed(request, fetched);
          continue;
        }
        const minute = Math.floor(request.at.getTime() / 1000 / MINUTE);
        results[index] = this.lookup(request, minute, fetched);
      }
    }
    return results;
  }

  private lookup(request: HistoricalPriceRequest, minute: number, candlesByMinute: ReadonlyMap<number, string>): HistoricalPriceResult {
    for (let back = 0; back <= LOOKBACK_MINUTES; back += 1) {
      const open = candlesByMinute.get(minute - back);
      if (open === undefined) continue;
      return {
        status: "FOUND",
        observation: {
          asset: request.asset, requestedAt: request.at, observedAt: new Date((minute - back) * MINUTE * 1000), priceUsd: open, provider: this.name,
          granularitySeconds: MINUTE, confidenceBps: back === 0 ? 9500 : 9000,
        },
      };
    }
    return { status: "NOT_AVAILABLE", asset: request.asset, requestedAt: request.at, provider: this.name, reason: "NO_CANDLE_WITHIN_5_MINUTES" };
  }

  /** Returns candle opens keyed by minute index, or a failure reason. */
  private async fetchCandles(fromSeconds: number, toSeconds: number): Promise<ReadonlyMap<number, string> | string> {
    const url = new URL("/products/SOL-USD/candles", this.baseUrl);
    url.searchParams.set("granularity", String(MINUTE));
    url.searchParams.set("start", new Date(fromSeconds * 1000).toISOString());
    url.searchParams.set("end", new Date(toSeconds * 1000).toISOString());
    let reason = "UNAVAILABLE";
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (attempt > 0) await this.sleep(2 ** attempt * 250);
      await this.limiter.acquire();
      try {
        const response = await this.request(url, { headers: { accept: "application/json", "user-agent": "solana-intelligence/0.1" }, signal: AbortSignal.timeout(this.timeoutMs) });
        if (response.status === 429 || response.status >= 500) {
          reason = response.status === 429 ? "RATE_LIMITED" : `HTTP_${String(response.status)}`;
          const retryAfter = Number(response.headers.get("retry-after"));
          if (Number.isFinite(retryAfter) && retryAfter > 0) await this.sleep(Math.min(retryAfter, 30) * 1000);
          continue;
        }
        if (!response.ok) return `HTTP_${String(response.status)}`;
        const parsed = candles.safeParse(await response.json());
        if (!parsed.success) return "INVALID_RESPONSE";
        // Candle open is used as the price; it is converted with String() and never through arithmetic.
        return new Map(parsed.data.map(([time, , , open]) => [Math.floor(time / MINUTE), String(open)] as const));
      } catch {
        reason = "TIMEOUT_OR_NETWORK";
      }
    }
    return reason;
  }
}
