import { Worker } from "bullmq";
import {
  HeliusBlockchainProvider,
  HeliusRpcClient,
  HeliusWebhookManager,
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
  enqueueWalletRecompute,
  finalityCheckJob,
  gapBackfillJob,
  ingestWalletHistoryJob,
  jobIds,
  normalizeLiveEventJob,
  queueNames,
  reconcileSubscriptionsJob,
  tokenLaunchEnrichmentJob,
  walletRecomputeJob,
} from "@swi/queue";
import { startHealthServer } from "./health-server.js";
import { recordJobFailure, withTimeout } from "./job-support.js";
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

const config = parseConfig(process.env);
const liveEnabled = config.ENABLE_LIVE_INGESTION;
const logger = createLogger({ service: "worker", level: config.LOG_LEVEL });
const metrics = new MetricsRegistry();
const database = createDatabase(config.DATABASE_URL);
const redis = createRedisConnection(config.REDIS_URL, "general");
const queueRedis = createRedisConnection(config.REDIS_URL, "bullmq");
const healthServer = startHealthServer({
  database,
  redis,
  queueRedis,
  port: Number(process.env["PORT"] ?? 8080),
  metrics,
});
const queues = createQueues(queueRedis);

const helius = config.HELIUS_API_KEY
  ? new HeliusBlockchainProvider({ apiKey: config.HELIUS_API_KEY })
  : undefined;
const rpc = config.HELIUS_API_KEY
  ? new HeliusRpcClient({ apiKey: config.HELIUS_API_KEY })
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
};
const handlers: LiveHandlerDependencies = {
  database,
  scheduler,
  metrics,
  liveEnabled,
  ...(helius ? { history: helius } : {}),
  ...(subscriptions ? { subscriptions } : {}),
  ...(rpc ? { finality: rpc, launch: rpc } : {}),
  prices: createHistoricalPriceProvider(database),
};

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

const redisCommandName = (error: unknown): string => {
  if (typeof error !== "object" || error === null || !("command" in error))
    return "unknown";
  const command = error.command;
  if (
    typeof command !== "object" ||
    command === null ||
    !("name" in command) ||
    typeof command.name !== "string"
  )
    return "unknown";
  return command.name;
};

const observeWorkerRedisErrors = (worker: Worker, queue: string): void => {
  worker.on("error", (error) => {
    const command = redisCommandName(error);
    metrics.increment("redis_errors_total", { command, queue });
    logger.error(
      { queue, command, ...errorDetails(error) },
      "worker Redis error",
    );
  });
};

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
  },
);
observeWorkerRedisErrors(analysisWorker, queueNames.analysis);
analysisWorker.on("failed", (job, error) => {
  logger.error(
    { ...errorDetails(error), jobId: job?.id, attempts: job?.attemptsMade },
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
    },
  );
  observeWorkerRedisErrors(ingestionWorker, queueNames.transactionIngestion);
  ingestionWorker.on("failed", (job, error) => {
    logger.error(
      { ...errorDetails(error), jobId: job?.id, attempts: job?.attemptsMade },
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
              handleReconcileSubscriptions(handlers),
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
    },
  );
  observeWorkerRedisErrors(maintenanceWorker, queueNames.liveMaintenance);
  maintenanceWorker.on("failed", (job, error) => {
    logger.error(
      { ...errorDetails(error), jobId: job?.id, attempts: job?.attemptsMade },
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

  // Desired state is re-asserted on every start and periodically: restarting never loses subscription intent.
  await queues.liveMaintenance.upsertJobScheduler(
    "reconcile-scheduled",
    { every: 300_000 },
    { name: "reconcile-subscriptions", data: { reason: "scheduled" } },
  );
  await queues.liveMaintenance.upsertJobScheduler(
    "gap-scan-scheduled",
    { every: 900_000 },
    { name: "gap-scan", data: {} },
  );
  await queues.transactionIngestion.upsertJobScheduler(
    "sweep-scheduled",
    { every: 60_000 },
    { name: "sweep", data: {} },
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
