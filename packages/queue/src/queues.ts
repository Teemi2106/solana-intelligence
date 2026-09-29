import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { queueNames } from "./contracts";

const defaultJobOptions: JobsOptions = {
  attempts: 6,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 86_400, count: 10_000 },
  removeOnFail: { age: 604_800, count: 50_000 },
};

export function createQueues(
  connection: Redis,
  onError: (error: Error, queue: string) => void = () => undefined,
) {
  const queues = {
    transactionIngestion: new Queue(queueNames.transactionIngestion, { connection, defaultJobOptions }),
    analysis: new Queue(queueNames.analysis, { connection, defaultJobOptions }),
    liveMaintenance: new Queue(queueNames.liveMaintenance, { connection, defaultJobOptions }),
    notificationDelivery: new Queue(queueNames.notificationDelivery, { connection, defaultJobOptions }),
    outcomeTracking: new Queue(queueNames.outcomeTracking, { connection, defaultJobOptions }),
  };
  // EventEmitter treats an unhandled `error` event as an uncaught exception. Queue operations still reject their
  // promises normally; this listener prevents a transient connection loss in BullMQ's internal JobScheduler from
  // crashing the process independently of those promises.
  for (const queue of Object.values(queues)) {
    queue.on("error", (error) => {
      onError(error, queue.name);
    });
  }
  return queues;
}

export type AppQueues = ReturnType<typeof createQueues>;

/** Job options for live normalization: more attempts than the default because provider events are durable and cheap to retry. */
export const normalizeJobOptions: JobsOptions = { attempts: 8, backoff: { type: "exponential", delay: 2_000 } };

// BullMQ forbids ':' in custom job ids. Ids derive from stable entity ids so re-enqueueing is a no-op while a job exists.
const bucket = (now: Date, seconds: number) => Math.floor(now.getTime() / (seconds * 1_000));

export const jobIds = {
  normalizeLiveEvent: (providerEventId: string) => `live-normalize-${providerEventId}`,
  walletRecompute: (walletId: string, mode: string, now: Date) => `recompute-${mode}-${walletId}-${String(bucket(now, 10))}`,
  finalityCheck: (signature: string, attempt: number) => `finality-${signature}-${String(attempt)}`,
  gapBackfill: (walletId: string, now: Date) => `gap-backfill-${walletId}-${String(bucket(now, 60))}`,
  reconcile: (now: Date) => `reconcile-${String(bucket(now, 15))}`,
  scheduledReconcile: (now: Date) => `reconcile-safety-${String(bucket(now, 6 * 60 * 60))}`,
  sweep: (now: Date) => `sweep-${String(bucket(now, 5 * 60))}`,
  gapScan: (now: Date) => `gap-scan-${String(bucket(now, 60 * 60))}`,
  tokenLaunch: (walletId: string, now: Date) => `token-launch-${walletId}-${String(bucket(now, 300))}`,
  tokenIntelligence: (requestId: string, now: Date) => `token-intelligence-${requestId}-${String(bucket(now, 300))}`,
  behaviorEvaluate: (walletId: string, now: Date) => `behavior-evaluate-${walletId}-${String(bucket(now, 10))}`,
  behaviorBaselineBuild: (walletId: string, now: Date) => `behavior-baseline-${walletId}-${String(bucket(now, 600))}`,
};

export async function enqueueBehaviorEvaluation(queues: Pick<AppQueues, "analysis">, walletId: string, now = new Date()): Promise<void> {
  await queues.analysis.add("behavior-evaluate", { walletId }, { jobId: jobIds.behaviorEvaluate(walletId, now), attempts: 4, backoff: { type: "exponential", delay: 5_000 } });
}

export async function enqueueBehaviorBaselineBuild(queues: Pick<AppQueues, "analysis">, walletId: string, now = new Date()): Promise<void> {
  await queues.analysis.add("behavior-baseline-build", { walletId }, { jobId: jobIds.behaviorBaselineBuild(walletId, now), attempts: 3, backoff: { type: "exponential", delay: 10_000 } });
}

export async function enqueueTokenIntelligence(queues: Pick<AppQueues, "analysis">, requestIds: readonly string[]): Promise<void> {
  if (requestIds.length === 0) return;
  const now = new Date();
  await queues.analysis.addBulk([...new Set(requestIds)].map((requestId) => ({
    name: "token-intelligence",
    data: { requestId },
    opts: { jobId: jobIds.tokenIntelligence(requestId, now), attempts: 4, backoff: { type: "exponential", delay: 5_000 } },
  })));
}

export async function enqueueNormalizeLiveEvents(queues: Pick<AppQueues, "transactionIngestion">, providerEventIds: readonly string[]): Promise<void> {
  if (providerEventIds.length === 0) return;
  await queues.transactionIngestion.addBulk(providerEventIds.map((providerEventId) => ({ name: "normalize-live-event", data: { providerEventId }, opts: { ...normalizeJobOptions, jobId: jobIds.normalizeLiveEvent(providerEventId) } })));
}

export async function enqueueWalletRecompute(queues: Pick<AppQueues, "analysis">, walletId: string, mode: "price-only" | "full", now: Date = new Date(), delayMs = 2_000): Promise<void> {
  await queues.analysis.add("wallet-recompute", { walletId, mode }, { jobId: jobIds.walletRecompute(walletId, mode, now), delay: delayMs });
}

export async function enqueueFinalityCheck(queues: Pick<AppQueues, "liveMaintenance">, signature: string, attempt: number, delayMs: number): Promise<void> {
  await queues.liveMaintenance.add("finality-check", { signature, attempt }, { jobId: jobIds.finalityCheck(signature, attempt), delay: delayMs, attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
}

export async function enqueueReconcileSubscriptions(queues: Pick<AppQueues, "liveMaintenance">, reason: string, now: Date = new Date()): Promise<void> {
  await queues.liveMaintenance.add("reconcile-subscriptions", { reason }, { jobId: jobIds.reconcile(now), attempts: 8, backoff: { type: "exponential", delay: 5_000 } });
}
