# Token intelligence (Phase 4)

Phase 4 enriches tokens encountered through canonical wallet transactions. It does not poll the token universe and does
not create signals. PostgreSQL stores durable enrichment intent and immutable observations; the existing BullMQ analysis
worker performs provider calls asynchronously.

## Providers and evidence

Helius RPC supplies finalized mint state, metadata, supply, authorities, and the bounded twenty-largest-token-account
view. Token accounts are grouped by owner before concentration is calculated. This is explicitly incomplete and never
reported as holder count. Accounts are classified as system/program-controlled only from concrete account evidence;
everything else remains `UNCLASSIFIED` and remains included.

DexScreener supplies Solana pool observations. Its JSON is decoded with lossless number handling. Pools are deduplicated
by address within one provider observation. The deepest pool with positive reported USD liquidity is the representative
market; total liquidity is the decimal-safe sum of unique usable pools. Individual pools and provenance are retained.

## Lifecycle and freshness

Successful wallet transactions classify meaningful traded assets as `FULL`; canonical stablecoins, wrapped SOL, and
routing/quote assets are `REDUCED`. Failed transactions create discovery evidence only. The transaction that discovers a
token also upserts a `token_enrichment_requests` outbox row. Queue enqueue failure therefore cannot lose intent.

Freshness is checked only after an explicit event/request:

| Component | Default |
|---|---:|
| Active market | 5 minutes |
| Holder evidence | 24 hours |
| Metadata | 24 hours |
| Mint authorities | 6 hours |

These are cache gates, not polling schedules. A one-minute outbox dispatcher republishes only already-pending durable
requests. It never scans tokens or creates refresh intent. PostgreSQL leases prevent two replicas from enriching the same
request concurrently.

## Risk evidence

There is no Phase 4 risk score. A snapshot records observed facts, evidence-linked indicators, and unavailable evidence.
Current indicators are mint authority enabled, freeze authority enabled, no usable market, a single usable pool, stale
market data, and incomplete holder enumeration. Missing evidence produces `INDETERMINATE` or an unavailable component;
it never implies safety.
