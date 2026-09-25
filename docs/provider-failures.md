# Provider failure handling

| Failure | Behavior |
|---|---|
| Helius unavailable | Accept only authenticated deliverable events; retry provider enrichment asynchronously; expose lag |
| Duplicate/out-of-order event | Upsert deterministic identity; order analysis by chain time/slot; recompute bounded affected state |
| Redis unavailable | Readiness fails; durable received event remains in PostgreSQL and reconciliation republishes it |
| PostgreSQL unavailable | Webhook cannot claim durability and returns a retryable failure; workers fail jobs without acknowledging |
| Market rate limit/timeout | Respect retry hints, exponential backoff, cache fresh snapshots, mark stale/missing quality |
| Telegram unavailable | Signal remains committed; delivery retries independently and records final failure |
| Worker crash/deploy | BullMQ lock expiry redelivers; database idempotency makes repeat execution safe |
| Malformed provider data | Reject/quarantine with safe metadata and validation issue codes; never partially normalize |
| Extreme volume | Edge limits, bounded queues/concurrency, priority classes, and visible processing lag |

Operators investigate retained failures by correlation/event ID, repair the underlying issue, and replay by persisted entity ID. Raw secrets and unrestricted provider payloads are never copied into failure logs.
