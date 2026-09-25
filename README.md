# Solana Intelligence

Private, read-only Solana wallet intelligence and signal monitoring. The platform observes public on-chain activity, builds time-versioned wallet profiles, detects independence-adjusted convergence, records explainable signals, and measures what happens after detection. It never holds keys or executes trades.

## Status

Phase 1 foundation and the Phase 2 wallet-intelligence vertical slice are implemented: audited wallet CRUD, resumable Helius history ingestion, normalized flows/trades, deterministic FIFO accounting, time-versioned scores/classifications, and persisted-data wallet screens. USD performance stays unknown until reliable historical pricing is available; the UI does not fabricate it.

## Architecture

This is a modular monolith with two deployable processes:

- `apps/web`: Next.js operator dashboard and bounded HTTP endpoints.
- `apps/worker`: persistent BullMQ consumers and worker health server.
- `packages/domain`: provider-independent types, values, and ports.
- `packages/db`: Drizzle schema, database lifecycle, and migrations.
- `packages/queue`: queue contracts, connections, and retry defaults.
- `packages/config`: fail-fast server configuration.
- `packages/validation`: boundary validation primitives.
- `packages/observability`: structured logging and redaction.

See [architecture](docs/architecture.md) and [data model](docs/data-model.md).

## Local setup

Requirements: Node.js 22+, npm 11+, Docker with Compose.

1. Copy `.env.example` to `.env` and fill all foundation variables.
2. Generate a 32-byte base64 secret for `AUTH_SECRET`.
3. Generate an Argon2id hash for `ADMIN_PASSWORD_HASH`; never store the plaintext password.
4. Run `docker compose up -d`.
5. Run `npm install` and `npm run db:migrate`. Root local commands load the single root `.env` through `scripts/run-with-env.mjs`; production deployments continue to inject environment variables normally.
6. Start the dashboard with `npm run dev:web` and the worker with `npm run dev:worker`.

Keep `ENABLE_LIVE_INGESTION=false` and `ENABLE_TELEGRAM=false` until their credentials and later-phase adapters are configured.

To test Phase 2, set `HELIUS_API_KEY`, run `npm run dev:web` and `npm run dev:worker`, sign in, and add a public address under `/wallets`. Progress is persisted per page and resumes after worker restarts.

## Quality gates

```text
npm run lint
npm run typecheck
npm test
npm run build
```

## Credentials and accounts

Foundation requires PostgreSQL, Redis, an application origin, a random session secret, and a private administrator credential. Live phases additionally require:

- Helius developer account: API key and webhook secret.
- Telegram bot created through BotFather: bot token and private chat/channel ID.
- Market providers: Jupiter and DexScreener generally expose public endpoints, but obtain paid/API credentials if required by production limits.
- Sentry-compatible project and DSN (optional but recommended).
- Hosting: Vercel or equivalent for the web app; Railway, Fly.io, Render, or equivalent persistent compute for workers; managed PostgreSQL and Redis.

No Solana seed phrase or private key is ever required.
