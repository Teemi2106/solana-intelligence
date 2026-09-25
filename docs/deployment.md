# Deployment

## Topology

- Web: Vercel or an equivalent autoscaled Next.js runtime.
- Workers: at least one persistent container on Railway, Fly.io, Render, or Kubernetes. Scale consumers horizontally by queue pressure and provider limits.
- PostgreSQL: managed, point-in-time recovery enabled, connection pooler available.
- Redis: managed, TLS and persistence enabled; eviction disabled for BullMQ keys.
- Error/metrics backend: Sentry-compatible errors plus a metrics/log platform.

Web and worker deployments use the same code revision and database migration version. Deploy migrations as an explicit release job before rolling application instances. Workers receive sufficient termination grace to stop accepting jobs and release locks.

## Health

Web exposes `/api/health/live` and `/api/health/ready`. Workers expose `/health/live` and `/health/ready` on `PORT` (default 8080). Liveness is process-only. Readiness checks PostgreSQL and Redis.

## Scaling and recovery

Correctness never depends on process memory. BullMQ uses bounded concurrency, retry limits, exponential backoff, and retained failed jobs. PostgreSQL uniqueness and conditional state transitions protect against duplicate execution. Backups must be restored in a staging environment on a schedule.
