/**
 * Provider-neutral boundary for timestamped USD prices. Accounting depends only on these types;
 * concrete providers (exchange candles, aggregator APIs, ...) live behind them.
 */
export interface HistoricalPriceRequest {
  /** Token mint (native SOL is requested as the wrapped-SOL mint). */
  readonly asset: string;
  readonly at: Date;
}

export interface HistoricalPriceObservation {
  readonly asset: string;
  readonly requestedAt: Date;
  /** Start of the candle/print the price was taken from. */
  readonly observedAt: Date;
  /** Decimal string, USD per whole unit of the asset. */
  readonly priceUsd: string;
  readonly provider: string;
  readonly granularitySeconds: number;
  readonly confidenceBps: number;
  /** Identifier of the persisted observation, when a store recorded it. */
  readonly observationId?: string;
}

export type HistoricalPriceResult =
  | { readonly status: "FOUND"; readonly observation: HistoricalPriceObservation }
  /** The provider was reachable but has no price for this asset/time. Cacheable. */
  | { readonly status: "NOT_AVAILABLE"; readonly asset: string; readonly requestedAt: Date; readonly provider: string; readonly reason: string }
  /** The provider does not cover this asset. Cacheable. */
  | { readonly status: "UNSUPPORTED"; readonly asset: string; readonly requestedAt: Date; readonly provider: string; readonly reason: string }
  /** Transient failure (timeout, rate limit, outage). Never cached as a miss. */
  | { readonly status: "ERROR"; readonly asset: string; readonly requestedAt: Date; readonly provider: string; readonly reason: string };

export interface HistoricalPriceProvider {
  readonly name: string;
  /** Width of one price bucket; identical (provider, asset, bucket) requests share one cached observation. */
  readonly granularitySeconds: number;
  supports(asset: string): boolean;
  /** Results are positionally aligned with `requests`. Implementations batch internally where the upstream allows. */
  getPrices(requests: readonly HistoricalPriceRequest[]): Promise<readonly HistoricalPriceResult[]>;
}
