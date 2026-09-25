# Pricing and accounting methodology (Phase 2)

Realized accounting represents what the wallet actually paid and received. External market prices are a fallback, never the default.

## 1. Swap economics (`packages/domain/src/swap-economics.ts`)

Only assets moved by the wallet's own accounts are considered, so aggregator intermediates (`SOL -> A -> B -> TOKEN`) net out and never become wallet trades. Per swap the system derives and persists: asset spent, amount spent, asset received, amount received, quote asset, execution price (quote per token), fees, whether SOL/wSOL were normalized, whether the swap was routed (aggregator venue or intermediate assets moved) and the route assets.

SOL and wSOL are one economic asset (`So111…`, 9 decimals). Its net leg is built from exact integer ledgers:

| Ledger | Meaning |
|---|---|
| wallet native delta | lamports the wallet gained/lost |
| + network fee | base + priority fee, removed from consideration, persisted separately |
| + wallet token-account rent | ATA creation (+) / closure refund (-); wSOL principal inside a wallet wSOL account is not rent |
| + bundle tips | native transfers to the eight Jito tip accounts, execution cost |
| counterparty wSOL delta | exact mirror of the wallet's wSOL exposure, including temporary wSOL accounts that are created and closed in the same transaction (rent for those nets to zero and never appears) |

When the counterparty wSOL ledger exists it is authoritative (`consideration = EXACT`); the difference to the wallet-side ledger is rent the wallet funded for third-party accounts (creator vaults, volume accumulators: 1.49M-2.04M lamports observed) and is persisted as `unattributed_lamports`, up to 0.01 SOL. A larger gap is not guessed: the token leg is kept and the consideration becomes `AMBIGUOUS`. Without a wSOL ledger (native pump.fun bonding-curve trades) the wallet-side ledger is used and marked `DERIVED`.

Stablecoins are recognised only by an explicit mint + decimals allow-list (USDC, USDT; verified on-chain). Symbols and names are never used. Token-for-token swaps produce a disposal and an acquisition with an unknown quote asset. SOL<->USDC is a quote-to-quote swap and not a token trade. A trade whose consideration cannot be established is still persisted (`AMBIGUOUS_CONSIDERATION`).

## 2. Pricing hierarchy (`packages/domain/src/pricing.ts`)

1. **Stablecoin flow.** USDC/USDT paid or received is USD 1:1 (peg assumption, 9900 bps). State `PRICED_FROM_STABLECOIN_FLOW`, basis `EXACT`.
2. **SOL/wSOL flow.** Lamports from the swap x SOL/USD at the swap's timestamp. State `PRICED_FROM_SOL_FLOW`, basis `DERIVED`. Missing SOL/USD gives `MISSING_QUOTE_USD_PRICE`.
3. **Other quote assets.** Priced only if a history provider independently covers the quote asset, else the token's own benchmark price with confidence capped at 6000 bps. State `PRICED_FROM_EXTERNAL_HISTORY`, basis `EXTERNAL`.
4. **Unknown.** `MISSING_HISTORICAL_PRICE` (or `AMBIGUOUS_CONSIDERATION`). Nothing is invented and the trade stays in inventory. The operator-facing reasons are in `pricing_issues`.

`RECONSTRUCTED_UNPRICED` is the state between reconstruction and pricing. Confidence (bps) = flow confidence (exact 10000, derived 8000) x price confidence. Fees are converted at the same timestamp's SOL/USD; an unknown fee is flagged and treated as zero in FIFO with a soft issue.

## 3. Historical price provider

`HistoricalPriceProvider` (domain port) supports timestamp lookup, batched requests, and results `FOUND | NOT_AVAILABLE | UNSUPPORTED | ERROR`. Implementations in `packages/market-data`:

- `CoinbaseSolUsdProvider`: SOL/USD from Coinbase Exchange public one-minute candles (`/products/SOL-USD/candles`, 300 candles per request, no key). The candle **open** of the minute containing the timestamp is used (confidence 9500); a previous candle within five minutes bridges gaps (9000); older is `NOT_AVAILABLE`. Requests are grouped into 240-minute windows (one upstream call per window), spaced at least 350 ms apart, three attempts with backoff and `retry-after`, 10 s timeout. Chosen after checking documentation: Pyth Benchmarks now requires an API key (as of 2026-08-26) and Binance is region-restricted.
- `CachingHistoricalPriceProvider`: per (provider, asset, minute) de-duplication, in-flight coalescing, memory and durable store. Found prices and definitive misses are stored in `historical_price_points` and the first write wins, so reprocessing uses identical prices; transient errors are never stored. Trades reference the exact observation row (`price_observation_id`).
- `RoutingHistoricalPriceProvider`: assets no provider covers are `UNSUPPORTED`.

No provider here claims to price long-tail Solana tokens historically; none does reliably with free access. Such trades price from their SOL/stablecoin flow, or stay unpriced.

## 4. Accounting and evidence

FIFO per token (`calculateFifoAccounting`), ordered by time, slot, acquisitions before disposals inside one slot, then signature (ids are random and never used, so reprocessing is deterministic). Buys carry cost basis = consideration + fee; sells net proceeds = consideration - fee; partial sells consume lots pro rata. Sales without inventory (tokens received outside a reconstructed trade) are recorded as deficits and are not evidence. Unrealized PnL stays unknown: no reliable valuation price exists for long-tail inventory.

Performance snapshots (7/30/90 days) use one row per sale, only if its pricing confidence is at least 7000 bps and cost basis is fully known. A window is eligible with at least 5/10/20 such sales and 80% coverage of the window's sales; otherwise the snapshot is stored as `INSUFFICIENT` with reasons and no metrics. A wallet score needs 30 trustworthy sales in 90 days **and** the copyability/allocation inputs, which Phase 3 provides, so scoring is currently unavailable by design.

## 5. Limitations

- Closing an already-empty token account (no token change) is not visible in balance changes; on the exact wSOL ledger path it is absorbed by the tolerance, on the native-only path it would slightly inflate proceeds. Unattributed lamports are always recorded.
- The peg is assumed for USDC/USDT.
- Intra-slot ordering is unknown; the acquisition-first convention is documented above.
