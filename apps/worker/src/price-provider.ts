import type { HistoricalPriceProvider } from "@swi/domain";
import type { Database } from "@swi/db";
import { CachingHistoricalPriceProvider, CoinbaseSolUsdProvider, RoutingHistoricalPriceProvider } from "@swi/market-data";
import { PostgresPriceStore } from "./price-store.js";

/**
 * Historical USD price stack: durable cache -> exchange candles for SOL/USD. Long-tail tokens are not covered
 * by any provider, so they resolve to UNSUPPORTED (and trades stay unpriced) rather than receive a guessed price.
 */
export function createHistoricalPriceProvider(database: Database): HistoricalPriceProvider {
  return new RoutingHistoricalPriceProvider([new CachingHistoricalPriceProvider(new CoinbaseSolUsdProvider(), new PostgresPriceStore(database))]);
}
