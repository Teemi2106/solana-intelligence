# Security

## Controls

- Dashboard sessions are short-lived, issuer/audience-bound, HTTP-only, same-site cookies signed with a server-only secret.
- Passwords are verified against Argon2id hashes. Login is origin checked and rate limited in shared Redis.
- Proxy checks improve routing, but protected layouts repeat authorization server-side.
- Security headers deny framing, restrict browser capabilities, and establish a restrictive CSP.
- Configuration fails at startup when required or enabled-integration secrets are absent.
- Logs structurally redact authorization, cookies, password fields, and provider tokens.
- Database access uses Drizzle/Postgres parameterization.
- External HTTP adapters must use fixed provider origins, bounded bodies, timeouts, and `AbortController`; arbitrary URLs are prohibited.
- Privileged mutations write an audit record containing actor, request, action, target, and safe before/after state.

## Secrets and wallets

Only public Solana addresses are tracked. The system must never request or store seed phrases/private keys and has no transaction-signing capability. Telegram, Helius, database, Redis, auth, and monitoring credentials are server-only.

## Live webhook endpoint (Phase 3)

See `docs/live-ingestion.md`: shared-secret constant-time verification (Helius echoes the configured authHeader; it is not a signature), streamed 1 MiB body bound, strict schema, per-source and failed-auth rate limits, feature-flag 404, generic error bodies and tested log redaction. Run it behind a proxy that overwrites `X-Forwarded-For`.

## Remaining phase gates

Before enabling live ingestion in production: add an edge body-size limit in front of the app, load-test rate limits, and rotate the webhook secret on a schedule. Before production: use a managed secret store, rotate bootstrap admin credentials, add Sentry scrubbing tests, run dependency audit, and commission a focused security review.
