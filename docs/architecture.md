# Architecture

## Decision

The system is a modular monolith deployed as a web process and independently scalable worker processes. PostgreSQL is authoritative. Redis/BullMQ transports retryable work and schedules measurements. This avoids premature service boundaries while preventing serverless request lifetimes from owning persistent monitoring.

## Final directory shape

```text
apps/
  web/                    Next.js dashboard, auth, APIs, webhook edge
  worker/                 persistent queue consumers and readiness server
packages/
  blockchain/             Helius adapter, RPC adapter, DTO normalization
  config/                 environment validation and feature gates
  db/                     Drizzle schema, repositories, migrations
  domain/                 entities, value objects, provider ports
  market-data/            Jupiter/DexScreener/Helius adapters and cache policy
  notifications/          Telegram adapter and safe formatting
  observability/          logs, metrics, error reporting
  queue/                  BullMQ contracts and factories
  signals/                convergence, independence, scoring, outcomes
  validation/             shared boundary schemas
docs/                     design and operating documentation
```

Packages not needed by Phase 1 are added only in the phase that uses them.

Phase 2 adds `packages/market-data` (historical USD price providers, cache) and pricing/accounting, see `docs/pricing-and-accounting.md`. It also adds `packages/blockchain`, containing the Helius history adapter and provider error translation. Historical wallet pages are consumed by the worker through the domain `BlockchainProvider` port.

Phase 3 adds `packages/ingestion` (shared transaction store, webhook handler, live-event normalization, finality, subscription reconciliation, gap backfill). See `docs/live-ingestion.md`.

## Provider boundaries

Domain services consume `BlockchainProvider`, `MarketDataProvider`, and `NotificationProvider` ports. Provider adapters own authentication, timeouts, rate-limit interpretation, DTO validation, and translation. Provider DTOs never enter scoring or persistence APIs directly. Queue payloads contain stable internal IDs, not large external payloads.

## Asynchronous event flow

```text
Helius webhook
  -> authenticate + size/rate limit
  -> validate envelope
  -> insert provider_event on deterministic identity
  -> enqueue event ID with deterministic job ID
  -> acknowledge

transaction-ingestion worker
  -> claim event conditionally
  -> normalize relevant wallet effects
  -> persist transaction/trades atomically
  -> enqueue analysis IDs

analysis worker
  -> refresh bounded wallet/token facts
  -> evaluate early movement and convergence using as-of data
  -> persist immutable signal and wallet evidence atomically
  -> enqueue notification and outcome jobs

notification worker                 outcome worker
  -> deliver pending record          -> measure due horizon
  -> record provider result          -> persist observation/quality
```

External network calls are never made while holding database transactions. Signal persistence commits before notification is attempted.

## Idempotency

- Webhook identity is `(provider, external_event_id)`; the payload hash detects conflicting re-delivery.
- Transaction identity includes wallet, signature, outer instruction, and inner instruction.
- Queue job IDs derive from stage plus persisted entity ID. Workers also use database state transitions, because BullMQ is at-least-once.
- Signals use a deterministic condition/window key when evaluation is implemented; escalation creates an explicit revision or distinct deduplicated alert.
- Alerts have a semantic deduplication key; delivery identity includes alert, provider, and destination.
- Outcomes are unique by signal and horizon.

A crash can repeat work but cannot create a second logical record. A queue acknowledgement is never the sole proof of completion.

Historical wallet ingestion persists a run and checkpoint after every page. The cursor advances in the same transaction that stores the page. Retried pages are harmless because provider events, wallet transactions, and token flows have deterministic unique identities. The next job ID derives from the run and cursor.

## Trust boundaries

Internet payloads, provider responses, token metadata, and queue data are untrusted. Each is schema-validated at entry. Web and workers read server-only secrets. The browser receives display DTOs only. Administrative mutations require an authenticated server-side authorization check and an audit record.
