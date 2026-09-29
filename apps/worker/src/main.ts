import { UnrecoverableError, Worker } from "bullmq";
import {
  HeliusBlockchainProvider,
  HeliusRpcClient,
  HeliusTokenIntelligenceProvider,
  HeliusWebhookManager,
  ProviderRequestError,
} from "@swi/blockchain";
import { parseConfig } from "@swi/config";
import { createDatabase, schema } from "@swi/db";
import { ingestWalletHistoryPage } from "@swi/ingestion";
import {
  createLogger,
  errorDetails,
  MetricsRegistry,
} from "@swi/observability";
import {
  createQueues,
  createRedisConnection,
  enqueueFinalityCheck,
  enqueueNormalizeLiveEvents,
  enqueueReconcileSubscriptions,
  enqueueTokenIntelligence,
  enqueueWalletRecompute,
  finalityCheckJob,
  gapBackfillJob,
  ingestWalletHistoryJob,
  jobIds,
  normalizeLiveEventJob,
  queueNames,
  reconcileSubscriptionsJob,
  type RedisLifecycleEvent,
  RedisStartupError,
  sanitizeRedisFailure,
  tokenLaunchEnrichmentJob,
  tokenIntelligenceJob,
  verifyRedisStartup,
  walletRecomputeJob,
} from "@swi/queue";
import { startHealthServer } from "./health-server.js";
import {
  recordJobFailure,
  redisCommandName,
  withTimeout,
} from "./job-support.js";
import {
  handleFinalityCheck,
  handleGapBackfill,
  handleGapScan,
  handleNormalizeLiveEvent,
  handleReconcileSubscriptions,
  handleSweep,
  handleTokenLaunchEnrichment,
  handleWalletRecompute,
  type LiveHandlerDependencies,
  type LiveScheduler,
} from "./live-handlers.js";
import { createHistoricalPriceProvider } from "./price-provider.js";
import { createTelegramNotifier } from "./telegram-notifier.js";
import { enrichTokenRequest, findDueTokenEnrichmentRequests } from "./token-intelligence.js";
import { DexScreenerTokenPoolProvider } from "@swi/market-data";

const config = parseConfig(process.env);
const liveEnabled = config.ENABLE_LIVE_INGESTION;
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });
const metrics = new MetricsRegistry();
const database = createDatabase(config.DATABASE_URL);
const redis = createRedisConnection(config.REDIS_URL, "general");
const queueRedis = createRedisConnection(config.REDIS_URL, "bullmq");
let redisLifecycleSequence = 0;
const observeRedisStartup = (purpose: "general" | "bullmq") =>
  (event: RedisLifecycleEvent) => {
    redisLifecycleSequence += 1;
    logger.info(
      { purpose, sequence: redisLifecycleSequence, ...event },
      "Redis startup lifecycle",
    );
  };
try {
  await Promise.all([
    verifyRedisStartup(redis, observeRedisStartup("general")),
    verifyRedisStartup(queueRedis, observeRedisStartup("bullmq")),
  ]);
  logger.info({ tls: new URL(config.REDIS_URL).protocol === "rediss:" }, "Redis startup check passed");
} catch (error) {
  const details = error instanceof RedisStartupError ? error.details : sanitizeRedisFailure(error);
  logger.fatal({ purpose: "startup", ...details }, "Redis startup check failed");
  logger.info({ purpose: "startup", action: "application_disconnect_after_failed_check" }, "Redis startup cleanup");
  redis.disconnect(false);
  queueRedis.disconnect(false);
  await database.close();
  throw new RedisStartupError(details);
}
const healthServer = startHealthServer({
  database,
  redis,
  queueRedis,
  port: Number(process.env["PORT"] ?? 8080),
  metrics,
});
const queues = createQueues(queueRedis, (error, queue) => {
  metrics.increment("redis_errors_total", { command: redisCommandName(error), queue });
  logger.error(
    { purpose: "bullmq", queue, command: redisCommandName(error), ...errorDetails(error) },
    "queue Redis error",
  );
});
const liveNotifier = config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID
  ? createTelegramNotifier({ enabled: config.ENABLE_TELEGRAM, botToken: config.TELEGRAM_BOT_TOKEN, chatId: config.TELEGRAM_CHAT_ID })
  : undefined;

const helius = config.HELIUS_API_KEY
  ? new HeliusBlockchainProvider({ apiKey: config.HELIUS_API_KEY })
  : undefined;
const rpc = config.HELIUS_API_KEY
  ? new HeliusRpcClient({ apiKey: config.HELIUS_API_KEY })
  : undefined;
const canonicalEvidenceRpc = config.HELIUS_API_KEY
  ? new HeliusRpcClient({ apiKey: config.HELIUS_API_KEY, timeoutMs: 5_000, maxAttempts: 2 })
  : undefined;
const tokenChainProvider = config.ENABLE_TOKEN_INTELLIGENCE && config.HELIUS_API_KEY
  ? new HeliusTokenIntelligenceProvider({ apiKey: config.HELIUS_API_KEY })
  : undefined;
const tokenMarketProvider = config.ENABLE_TOKEN_INTELLIGENCE
  ? new DexScreenerTokenPoolProvider()
  : undefined;
// Subscriptions are only ever created when live ingestion is enabled (config validation guarantees the settings exist).
const subscriptions =
  liveEnabled &&
  config.HELIUS_API_KEY &&
  config.HELIUS_WEBHOOK_SECRET &&
  config.LIVE_WEBHOOK_PUBLIC_URL
    ? new HeliusWebhookManager({
        apiKey: config.HELIUS_API_KEY,
        webhookUrl: config.LIVE_WEBHOOK_PUBLIC_URL,
        webhookSecret: config.HELIUS_WEBHOOK_SECRET,
        requestDiagnostic: (diagnostic) => {
          logger.info(diagnostic);
        },
      })
    : undefined;

const scheduler: LiveScheduler = {
  normalize: (ids) => enqueueNormalizeLiveEvents(queues, ids),
  recompute: (walletId, mode, delayMs) =>
    enqueueWalletRecompute(queues, walletId, mode, new Date(), delayMs),
  finalityCheck: (signature, attempt, delayMs) =>
    enqueueFinalityCheck(queues, signature, attempt, delayMs),
  gapBackfill: async (walletId) => {
    await queues.liveMaintenance.add(
      "gap-backfill",
      { walletId },
      {
        jobId: jobIds.gapBackfill(walletId, new Date()),
        attempts: 4,
        backoff: { type: "exponential", delay: 10_000 },
      },
    );
  },
  enrichLaunchFacts: async (walletId) => {
    await queues.analysis.add(
      "token-launch-enrichment",
      { walletId },
      {
        jobId: jobIds.tokenLaunch(walletId, new Date()),
        attempts: 4,
        backoff: { type: "exponential", delay: 30_000 },
      },
    );
  },
  enrichTokenRequests: (requestIds) => config.ENABLE_TOKEN_INTELLIGENCE ? enqueueTokenIntelligence(queues, requestIds) : Promise.resolve(),
};
const handlers: LiveHandlerDependencies = {
  database,
  scheduler,
  metrics,
  liveEnabled,
  ...(helius ? { history: helius } : {}),
  ...(subscriptions ? { subscriptions } : {}),
  ...(rpc ? { finality: rpc, launch: rpc } : {}),
  ...(canonicalEvidenceRpc ? { canonicalEvidence: canonicalEvidenceRpc } : {}),
  prices: createHistoricalPriceProvider(database),
  logger,
  ...(liveNotifier ? { liveNotifier } : {}),
  recoveryIntegrityIntervalMs: config.RECOVERY_INTEGRITY_INTERVAL_HOURS * 60 * 60_000,
  recoveryShadowMode: config.RECOVERY_SHADOW_MODE,
};

// An idle BullMQ worker otherwise wakes its blocking Redis command every five seconds.
// Markers still wake workers immediately when a job arrives, so a longer drained wait cuts idle commands without
// adding job latency. Stalled checks remain frequent relative to the longest lock and preserve crash recovery.
const idleWorkerOptions = { drainDelay: 60, stalledInterval: 120_000 } as const;
const safetyTimers: NodeJS.Timeout[] = [];
function scheduleSafetyJob(intervalMs: number, enqueue: () => Promise<unknown>): void {
  const timer = setInterval(() => {
    void enqueue().catch((error: unknown) => {
      logger.error(errorDetails(error), "safety job enqueue failed");
    });
  }, intervalMs);
  timer.unref();
  safetyTimers.push(timer);
}

const observe = (
  queue: string,
  job: { name: string } | undefined,
  outcome: string,
  startedAt: number,
) => {
  metrics.increment("jobs_total", {
    queue,
    job: job?.name ?? "unknown",
    outcome,
  });
  metrics.observe("job_duration_ms", Date.now() - startedAt, {
    queue,
    job: job?.name ?? "unknown",
  });
};

if (config.ENABLE_TOKEN_INTELLIGENCE) {
  // Durable outbox recovery only: this republishes explicit pending intent and never scans or refreshes tokens globally.
  scheduleSafetyJob(60_000, async () => {
    const requestIds = await findDueTokenEnrichmentRequests(database, 100);
    if (requestIds.length > 0) await enqueueTokenIntelligence(queues, requestIds);
  });
}

const observeWorkerRedisErrors = (worker: Worker, queue: string): void => {
  worker.on("error", (error) => {
    const command = redisCommandName(error);
    metrics.increment("redis_errors_total", { command, queue });
    logger.error(
      { purpose: "bullmq", queue, command, ...errorDetails(error) },
      "worker Redis error",
    );
  });
};

const jobFailureDetails = (
  job:
    | {
        id?: string;
        name: string;
        attemptsMade: number;
        opts: { attempts?: number };
        processedOn?: number;
      }
    | undefined,
  error: unknown,
) => ({
  purpose: "bullmq",
  command: redisCommandName(error),
  jobId: job?.id,
  jobName: job?.name,
  attemptsMade: job?.attemptsMade,
  maxAttempts: job?.opts.attempts,
  elapsedMs: job?.processedOn ? Date.now() - job.processedOn : undefined,
});

// ---- analysis: always on (historical ingestion and accounting keep working with live ingestion disabled) ----------------
const analysisWorker = new Worker(
  queueNames.analysis,
  async (job) => {
    const startedAt = Date.now();
    try {
      switch (job.name) {
        case "wallet-history": {
          const payload = ingestWalletHistoryJob.parse(job.data);
          if (!helius) throw new Error("HELIUS_API_KEY_REQUIRED_FOR_HISTORY");
          const result = await withTimeout(
            ingestWalletHistoryPage({ database, provider: helius }, payload),
            120_000,
            "WALLET_HISTORY",
          );
          if (result.completed) {
            await enqueueWalletRecompute(
              queues,
              payload.walletId,
              "full",
              new Date(),
              0,
            );
            if (liveEnabled)
              await enqueueReconcileSubscriptions(queues, "history-completed");
          } else if (result.nextCursor)
            await queues.analysis.add("wallet-history", payload, {
              jobId: `wallet-history-${payload.runId}-${result.nextCursor.slice(0, 32)}`,
            });
          if (result.enrichmentRequestIds.length > 0) {
            try {
              await scheduler.enrichTokenRequests(result.enrichmentRequestIds);
            } catch (error) {
              logger.warn({ ...errorDetails(error), requestCount: result.enrichmentRequestIds.length }, "token enrichment enqueue deferred to durable recovery");
            }
          }
          return;
        }
        case "wallet-recompute": {
          const payload = walletRecomputeJob.parse(job.data);
          const result = await withTimeout(
            handleWalletRecompute(handlers, payload),
            300_000,
            "WALLET_RECOMPUTE",
          );
          logger.info(
            {
              walletId: payload.walletId,
              mode: payload.mode,
              pricing: result.pricing.byState,
              scoreEligible:
                result.intelligence?.scoreEligibility.eligible ?? null,
            },
            "wallet recomputed",
          );
          return;
        }
        case "token-launch-enrichment": {
          const payload = tokenLaunchEnrichmentJob.parse(job.data);
          await withTimeout(
            handleTokenLaunchEnrichment(handlers, payload.walletId),
            600_000,
            "TOKEN_LAUNCH",
          );
          return;
        }
        case "token-intelligence": {
          const payload = tokenIntelligenceJob.parse(job.data);
          if (!tokenChainProvider || !tokenMarketProvider) throw new UnrecoverableError("TOKEN_INTELLIGENCE_NOT_CONFIGURED");
          const result = await withTimeout(enrichTokenRequest({
            database,
            identity: tokenChainProvider,
            holders: tokenChainProvider,
            markets: tokenMarketProvider,
            freshness: {
              marketMs: config.TOKEN_MARKET_FRESHNESS_MINUTES * 60_000,
              holdersMs: config.TOKEN_HOLDER_FRESHNESS_HOURS * 60 * 60_000,
              metadataMs: config.TOKEN_METADATA_FRESHNESS_HOURS * 60 * 60_000,
              authoritiesMs: config.TOKEN_AUTHORITIES_FRESHNESS_HOURS * 60 * 60_000,
            },
          }, payload.requestId), 180_000, "TOKEN_INTELLIGENCE");
          logger.info({ requestId: payload.requestId, status: result.status, components: result.components }, "token intelligence processed");
          return;
        }
        default:
          throw new Error("UNKNOWN_ANALYSIS_JOB");
      }
    } finally {
      observe(queueNames.analysis, job, "finished", startedAt);
    }
  },
  {
    connection: queueRedis,
    concurrency: 2,
    lockDuration: 120_000,
    maxStalledCount: 2,
    limiter: { max: 20, duration: 1_000 },
    ...idleWorkerOptions,
  },
);
observeWorkerRedisErrors(analysisWorker, queueNames.analysis);
analysisWorker.on("failed", (job, error) => {
  logger.error(
    { ...jobFailureDetails(job, error), ...errorDetails(error) },
    "analysis job failed",
  );
  metrics.increment("jobs_failed_total", { queue: queueNames.analysis });
  void recordJobFailure(database, queueNames.analysis, job, error).catch(
    () => undefined,
  );
});

// ---- live ingestion: only constructed when enabled ------------------------------------------------------------------------
const liveWorkers: Worker[] = [];
if (liveEnabled) {
  const ingestionWorker = new Worker(
    queueNames.transactionIngestion,
    async (job) => {
      const startedAt = Date.now();
      try {
        if (job.name === "normalize-live-event") {
          const payload = normalizeLiveEventJob.parse(job.data);
          const result = await withTimeout(
            handleNormalizeLiveEvent(handlers, payload.providerEventId),
            60_000,
            "NORMALIZE_LIVE_EVENT",
          );
          logger.info(
            {
              eventId: payload.providerEventId,
              outcome: result.outcome,
              wallets: result.affected.length,
            },
            "live event normalized",
          );
          return;
        }
        if (job.name === "sweep") {
          const result = await handleSweep(handlers);
          if (result.eventsRequeued + result.finalityRequeued > 0)
            logger.warn(result, "sweeper recovered stuck work");
          return;
        }
        throw new Error("UNKNOWN_INGESTION_JOB");
      } finally {
        observe(queueNames.transactionIngestion, job, "finished", startedAt);
      }
    },
    {
      connection: queueRedis,
      concurrency: 10,
      lockDuration: 60_000,
      maxStalledCount: 3,
      ...idleWorkerOptions,
    },
  );
  observeWorkerRedisErrors(ingestionWorker, queueNames.transactionIngestion);
  ingestionWorker.on("failed", (job, error) => {
    logger.error(
      { ...jobFailureDetails(job, error), ...errorDetails(error) },
      "ingestion job failed",
    );
    metrics.increment("jobs_failed_total", {
      queue: queueNames.transactionIngestion,
    });
    void recordJobFailure(
      database,
      queueNames.transactionIngestion,
      job,
      error,
    ).catch(() => undefined);
  });

  const maintenanceWorker = new Worker(
    queueNames.liveMaintenance,
    async (job) => {
      const startedAt = Date.now();
      try {
        switch (job.name) {
          case "reconcile-subscriptions": {
            reconcileSubscriptionsJob.parse(job.data);
            const result = await withTimeout(
              handleReconcileSubscriptions(handlers).catch((error: unknown) => {
                if (error instanceof ProviderRequestError && !error.retryable)
                  throw new UnrecoverableError(error.message);
                throw error;
              }),
              120_000,
              "RECONCILE",
            );
            logger.info(
              {
                outcome: result.outcome,
                desired: result.desired,
                added: result.added.length,
                removed: result.removed.length,
              },
              "subscriptions reconciled",
            );
            return;
          }
          case "finality-check": {
            const payload = finalityCheckJob.parse(job.data);
            await withTimeout(
              handleFinalityCheck(handlers, payload),
              60_000,
              "FINALITY_CHECK",
            );
            return;
          }
          case "gap-backfill": {
            const payload = gapBackfillJob.parse(job.data);
            const result = await withTimeout(
              handleGapBackfill(handlers, payload.walletId),
              300_000,
              "GAP_BACKFILL",
            );
            logger.info(
              { walletId: payload.walletId, ...result },
              "gap backfill finished",
            );
            return;
          }
          case "gap-scan":
            await handleGapScan(handlers);
            return;
          default:
            throw new Error("UNKNOWN_MAINTENANCE_JOB");
        }
      } finally {
        observe(queueNames.liveMaintenance, job, "finished", startedAt);
      }
    },
    {
      connection: queueRedis,
      concurrency: 2,
      lockDuration: 120_000,
      maxStalledCount: 2,
      limiter: { max: 10, duration: 1_000 },
      ...idleWorkerOptions,
    },
  );
  observeWorkerRedisErrors(maintenanceWorker, queueNames.liveMaintenance);
  maintenanceWorker.on("failed", (job, error) => {
    logger.error(
      { ...jobFailureDetails(job, error), ...errorDetails(error) },
      "maintenance job failed",
    );
    metrics.increment("jobs_failed_total", {
      queue: queueNames.liveMaintenance,
    });
    void recordJobFailure(
      database,
      queueNames.liveMaintenance,
      job,
      error,
    ).catch(() => undefined);
  });
  liveWorkers.push(ingestionWorker, maintenanceWorker);

  // Remove scheduler definitions created by older releases; otherwise their delayed jobs survive deployment.
  await Promise.all([
    queues.liveMaintenance.removeJobScheduler("reconcile-scheduled"),
    queues.liveMaintenance.removeJobScheduler("gap-scan-scheduled"),
    queues.transactionIngestion.removeJobScheduler("sweep-scheduled"),
  ]);

  // These are safety nets, not the source of truth. Process timers avoid keeping delayed scheduler markers in Redis,
  // which force otherwise idle BullMQ workers to poll every ten seconds. Bucketed ids make ticks idempotent if
  // multiple replicas are running; a restart merely delays the next safety scan, while startup reconciliation below
  // immediately re-asserts subscription intent.
  scheduleSafetyJob(5 * 60_000, () =>
    queues.transactionIngestion.add("sweep", {}, { jobId: jobIds.sweep(new Date()) }),
  );
  scheduleSafetyJob(60 * 60_000, () =>
    queues.liveMaintenance.add("gap-scan", {}, { jobId: jobIds.gapScan(new Date()) }),
  );
  scheduleSafetyJob(6 * 60 * 60_000, () =>
    queues.liveMaintenance.add(
      "reconcile-subscriptions",
      { reason: "scheduled" },
      { jobId: jobIds.scheduledReconcile(new Date()), attempts: 8, backoff: { type: "exponential", delay: 5_000 } },
    ),
  );
  await enqueueReconcileSubscriptions(queues, "startup");
  logger.info("live ingestion enabled");
} else {
  logger.info(
    "live ingestion disabled: no subscriptions will be created and live workers are not started",
  );
}

const heartbeat = setInterval(() => {
  void database.query
    .insert(schema.systemHealth)
    .values({
      component: "worker",
      instanceId: String(process.pid),
      status: "up",
      details: { liveEnabled, metrics: metricsSnapshot() },
      heartbeatAt: new Date(),
    })
    .onConflictDoUpdate({
      target: schema.systemHealth.component,
      set: {
        instanceId: String(process.pid),
        status: "up",
        details: { liveEnabled, metrics: metricsSnapshot() },
        heartbeatAt: new Date(),
      },
    })
    .catch((error: unknown) => {
      logger.warn(errorDetails(error), "heartbeat failed");
    });
}, 15_000);
function metricsSnapshot(): Record<string, number> {
  return {
    normalized: metrics.counter("live_normalization_total", {
      outcome: "created",
      kind: "SWAP",
    }),
    jobsFailed:
      metrics.counter("jobs_failed_total", {
        queue: queueNames.transactionIngestion,
      }) +
      metrics.counter("jobs_failed_total", {
        queue: queueNames.liveMaintenance,
      }) +
      metrics.counter("jobs_failed_total", { queue: queueNames.analysis }),
  };
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "graceful shutdown started");
  clearInterval(heartbeat);
  for (const timer of safetyTimers) clearInterval(timer);
  healthServer.close();
  await analysisWorker.close();
  await Promise.all(liveWorkers.map((worker) => worker.close()));
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  await queueRedis.quit();
  await redis.quit();
  await database.close();
  logger.info("graceful shutdown complete");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => void shutdown(signal));
}
