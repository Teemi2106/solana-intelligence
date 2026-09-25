# Live wallet monitoring (Phase 3)

Observation only. Nothing in this system signs, trades, requests keys, copies trades or sends alerts.

## Helius facts this design relies on (checked against current documentation)

| Topic | Fact | Consequence |
|---|---|---|
| Webhook type | **Enhanced** (parsed) or raw. Enhanced payload = JSON array of the same enriched transactions the history API returns. Enhanced does **not** deliver failed transactions; raw does. | Enhanced is used, so live and historical normalization share one normalizer. Failed swaps are not trades anyway. |
| Authentication | The `authHeader` configured on the webhook is echoed in the `Authorization` header. A shared secret, not a signature. | Constant-time comparison only. No custom cryptography. |
| Limits | 100,000 addresses per webhook (API), 50 webhooks (5 on free). Create/edit/delete cost 100 credits each. | One webhook. Reconcile diffs first and writes only on change. Above 100,000 addresses reconcile fails visibly. |
| Acknowledgement | 200 within **1 second**. | Request path = validate, persist, enqueue, respond. |
| Retries | FAQ: 3 attempts, 1 s apart, then the event is **lost**. (API reference elsewhere says 24 h backoff; the worse case is assumed.) | Gap backfill from history recovers lost deliveries. |
| Duplicates | Possible; dedupe on signature. | Deterministic event identity + database constraints. |
| Ordering | Not guaranteed or documented. | FIFO never uses arrival order. |
| Finality | Sent after a transaction is **confirmed**, not finalized. | Stored as `confirmed`; finality is verified separately. |
| Auto-disable | Disabled at >= 95 % delivery failures (24 h free / 7 d paid); PATCH `{active:true}` re-enables. | Reconcile re-enables a disabled webhook. |
| URL | Must be public HTTPS (no localhost). | See "Local testing" below. |
| Update semantics | PUT payload semantics are not fully documented. | Every write is followed by a read-back and the address set is verified. |

## Request lifecycle (`POST /api/webhooks/helius`)

1. Live ingestion disabled -> `404`, nothing else happens.
2. Rate limit per source (Redis, 1200/min; fail-open if Redis is down, authentication still applies).
3. `Authorization` compared in constant time. Failures are additionally limited to 20/min per source (`429`).
4. Body bounded to 1 MiB, by declared length and by streamed length (`413`).
5. JSON parse (`400`), strict Zod schema, at most 100 transactions (`400`). Unknown fields are dropped, not stored.
6. One batched insert into `provider_events` (`ON CONFLICT DO NOTHING`), identity `helius:live:<signature>`.
7. Enqueue one `normalize-live-event` job per new event, bounded to 400 ms. Enqueue failure is tolerated: the event is durable and the sweeper recovers it.
8. `200 {accepted, duplicates}`. If nothing could be stored: `503` so Helius retries. Error bodies never contain internals.

No reconstruction, pricing, scoring or provider calls happen on this path. Measured locally: ~40 ms.

## Identity and idempotency

* **Event**: `provider_events(provider, external_event_id = helius:live:<signature>)` unique.
* **Canonical transaction**: `wallet_transactions(wallet, signature, instruction 0, inner -1)` unique. **Trades**: `(transaction, token, side)` unique. Flows: `(transaction, flow_index)` unique.
* Historical, gap-backfill and webhook ingestion all call one function, `persistNormalizedTransaction`, using `ON CONFLICT` clauses. A transaction already known creates no new trades; finality only ever moves `confirmed -> finalized`, never backwards.
* A transaction concerning several tracked wallets produces one canonical row per wallet.

## Queue topology

| Queue | Job | Job id | Notes |
|---|---|---|---|
| transaction-ingestion | `normalize-live-event` | `live-normalize-<eventId>` | 8 attempts, exponential backoff, no network calls |
| transaction-ingestion | `sweep` (every 60 s) | scheduler | requeues stuck events and unchecked confirmed transactions |
| analysis | `wallet-history` | run + cursor | unchanged; on completion enqueues a full recompute |
| analysis | `wallet-recompute` (`price-only` / `full`) | `recompute-<mode>-<wallet>-<10 s bucket>` | debounced |
| analysis | `token-launch-enrichment` | `token-launch-<wallet>-<5 min bucket>` | rate-limited, sequential |
| live-maintenance | `finality-check` | `finality-<signature>-<attempt>` | delayed, self-rescheduling, bounded (40 attempts) |
| live-maintenance | `reconcile-subscriptions` (every 5 min + on wallet change) | `reconcile-<15 s bucket>` | |
| live-maintenance | `gap-backfill` / `gap-scan` (every 15 min) | `gap-backfill-<wallet>-<1 min bucket>` | |

BullMQ forbids `:` in custom ids, hence `-`. Exhausted jobs are written to `processing_failures` (safe metadata only) and, for events, `provider_events.status = FAILED`. Every job has an outer timeout; provider adapters add their own request timeouts. No database transaction spans a network call.

## Ordering and finality

* Arrival order is never used. FIFO ordering is the Phase 2 rule: time, slot, acquisitions before disposals within a slot, signature.
* Live rows are `confirmed`. They appear in the live feed and are priced, but **only finalized rows feed lots, realizations, positions, snapshots, evidence and scores**.
* A delayed `finality-check` asks RPC (`getSignatureStatuses`). `FINALIZED` promotes the row and triggers a full recompute. A signature still unknown after 15 minutes, or reported failed, becomes `dropped` and is excluded permanently. History arriving later also promotes.
* A confirmed trade that is later dropped therefore never affected any accounting.

## Determinism

Recompute reads persisted rows and persisted price observations only. A test ingests 60 real transactions once historically and once through live delivery (shuffled, duplicated, redelivered late, finalized afterwards) in two separate databases and asserts identical trades, lots, realizations and positions. Reprocessing the real test wallet after Phase 3 produced byte-identical Phase 2 accounting fingerprints.

Performance snapshots, scores and classifications are append-only versions: a new row is written only when the observation changed, the previous row is closed (`valid_to`) and never edited.

## Subscription reconciliation

Desired state = `ACTIVE` rows of `tracked_wallets`. Reconcile reads the provider webhook, diffs, and only when different PUTs the full address set (creating the webhook if absent, re-enabling if disabled, pausing it if no wallet is active), then reads back and verifies. Every run is recorded in `provider_sync_runs`; `provider_subscriptions` caches the observed state (never authoritative); `wallet_live_monitoring.provider_confirmed_at` records which wallets the provider is confirmed to watch. Failures are recorded, the subscription is marked `ERROR`, and the job retries with backoff; the 5-minute schedule and worker restarts re-assert the intent. Newly monitored wallets get a gap backfill.

Limitation: if `LIVE_WEBHOOK_PUBLIC_URL` changes, the old webhook is no longer recognized as ours and a new one is created. Delete stale webhooks in the Helius dashboard (or use a stable URL).

## Crash and retry recovery

Persist -> enqueue -> process. A crash between persist and enqueue leaves `RECEIVED`/`QUEUED` events that the sweeper re-enqueues after 60 s. A crash during processing leaves `PROCESSING`, requeued after 5 minutes; each wallet's write is one transaction, so retries never see partial rows (tested with a database trigger that fails mid-write). Lost webhook deliveries are recovered by gap backfill.

## Copyability and allocation evidence (what can actually be established)

* Token first activity: Helius `getTransactionsForAddress` (ascending, limit 1) gives the mint's earliest transaction time and its first signer. Stored once per token in `token_launch_facts`.
* An **entry** is the wallet's first public swap acquisition of a token. It is *copyable* only if launch timing is known, it occurred at least 60 s after first activity, and the wallet did not sign the token's first transaction. `copyableTradeRatioBps` is computed only when launch facts cover >= 80 % of entries; otherwise the score is withheld.
* Allocation dependence = share of sale proceeds from inventory with no recorded public acquisition, or from tokens the wallet launched itself.
* Evidence rows are neutral (`NON_COPYABLE_ENTRY`, `EARLY_ALLOCATION_PATTERN`, `HIGH_ALLOCATION_DEPENDENCE`, `DEPLOYER_LINKED_TRANSFER`). The early-access label needs non-public-acquisition evidence across >= 3 distinct tokens and either >= 30 % of proceeds or >= 3 deployer-linked receipts; timing alone never qualifies. `RELATED_TEAM_LINKED` is never assigned in Phase 3. Smart-money classification requires a score >= 60, copyable ratio >= 50 % and low allocation dependence. Early-access and smart-money remain separate streams.
* Not observable, therefore not claimed: liquidity depth at entry, private information, motives, identity, funding relationships (not collected in Phase 3).
* Score inputs: max drawdown is relative to peak cumulative realized PnL; recent profitability is the 30-day win rate.

## Security review of the public endpoint

Shared-secret auth in constant time; failed-auth and overall rate limits; 1 MiB bound enforced while streaming; strict schema with unknown fields dropped; POST only; feature-flag 404; generic error bodies; no stack traces; fixed provider origins only (no request-supplied URLs); API keys sent only to fixed Helius origins and never included in errors; logger redacts `authorization`, cookies, `apiKey`, `authHeader`, `webhookSecret` and env-style secrets (tested); payload bodies are never logged. `X-Forwarded-For` is trusted only for rate-limit keys, so deploy behind a proxy that overwrites it. Because the shared secret is static, rotate it periodically (`HELIUS_WEBHOOK_SECRET`; reconcile does not update the provider's `authHeader` on rotation, so re-create the webhook after rotating).

## Configuration

Required when `ENABLE_LIVE_INGESTION=true` (validated at startup, fails with a clear message): `HELIUS_API_KEY`, `HELIUS_WEBHOOK_SECRET` (>= 32 chars), `LIVE_WEBHOOK_PUBLIC_URL` (https). With the flag off: no subscription is created, the webhook route returns 404, live workers are not started, the dashboard says so, and history/accounting keep working.

## Local testing

1. `docker compose up -d` (Postgres 5433, Redis 6379). `npm run db:migrate`.
2. `npm test` runs everything. Database-backed suites create a throwaway migrated database on the docker Postgres (override with `TEST_DATABASE_ADMIN_URL`) and skip if it is unreachable; BullMQ suites use Redis (`TEST_REDIS_URL`).
3. Manual end-to-end without touching Helius' management API: run web and worker with `ENABLE_LIVE_INGESTION=true` against a scratch database that has **no active wallet at worker start** (reconcile then only lists webhooks), insert an active wallet row, then POST a fixture:

   `curl -X POST http://localhost:3000/api/webhooks/helius -H "authorization: Bearer $HELIUS_WEBHOOK_SECRET" -H "content-type: application/json" --data-binary @body.json`

   Expect `{"accepted":N,"duplicates":0}`, a `confirmed` transaction and priced trade within seconds, and `finalized` after ~45 s (real RPC check).
4. Metrics: worker `GET :8080/metrics` (Prometheus text). Dashboard: `/system`, `/wallets/<address>`; JSON: `/api/system/live` (admin session).

## Exposing the local webhook for development

Helius rejects localhost and needs public HTTPS. Use a tunnel that exposes **only** the webhook path so the dashboard is not reachable from the internet:

1. Install `cloudflared`. Create a named tunnel (stable URL, so reconcile does not create duplicate webhooks): `cloudflared tunnel create swi-dev`.
2. `config.yml`:
   ```yaml
   tunnel: swi-dev
   credentials-file: <path>
   ingress:
     - hostname: swi-dev.example.com
       path: ^/api/webhooks/helius$
       service: http://localhost:3000
     - service: http_status:404
   ```
3. `cloudflared tunnel route dns swi-dev swi-dev.example.com`, then `cloudflared tunnel run swi-dev`.
4. `.env`: `ENABLE_LIVE_INGESTION=true`, `HELIUS_API_KEY=...`, `HELIUS_WEBHOOK_SECRET=$(openssl rand -base64 48)`, `LIVE_WEBHOOK_PUBLIC_URL=https://swi-dev.example.com/api/webhooks/helius`.
5. Start `npm run dev:web` and `npm run dev:worker`. The worker creates/updates the webhook on start; check `/system`. Quick tunnels (`--url`) work too but change URL on every run, which leaves stale webhooks to delete.
6. Add a tracked wallet in the dashboard; within one reconcile cycle it appears under "Actively monitored wallets".

## Remaining limitations

* Empty token-account closure with no token balance change may be invisible (Phase 2, unchanged). USDC/USDT peg assumed (unchanged). Trade order within one slot is unknown; the Phase 2 rule applies (unchanged).
* Enhanced webhooks never carry failed transactions, so failed attempts by a wallet are not visible live (historical ingestion still records them).
* Recompute rebuilds a wallet's accounting whole (debounced 10 s); an incremental update would be needed for very high-frequency wallets.
* One webhook only (100,000 addresses). Sharding is not implemented; exceeding it fails reconcile visibly.
* Launch facts need Helius `getTransactionsForAddress`; when unavailable the score stays withheld.
* Funding-relationship evidence (`RELATED_FUNDING_PATTERN`) is not collected.
* Webhook counters shown on `/system` are per web process; queue depth, latency and failures come from Redis/Postgres.
* Redis outage: webhooks are still acknowledged and persisted, processing resumes via the sweeper; the web app's rate limiter fails open.
