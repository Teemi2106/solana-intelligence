import { eq } from "drizzle-orm";
import type { Job } from "bullmq";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";

export class JobTimeoutError extends Error {
  constructor(label: string) {
    super(`${label}_TIMEOUT`);
    this.name = "JobTimeoutError";
  }
}

export function redisCommandName(error: unknown): string {
  if (typeof error !== "object" || error === null || !("command" in error)) return "unknown";
  const command = error.command;
  if (typeof command !== "object" || command === null || !("name" in command) || typeof command.name !== "string") return "unknown";
  return command.name;
}

/** Bounds a job's wall time. Provider adapters also carry their own request timeouts; this is the outer guard. */
export async function withTimeout<T>(work: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new JobTimeoutError(label)); }, milliseconds); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Records a permanently failed job (attempts exhausted) so an operator can investigate and replay by entity id.
 * Only safe metadata is stored: never payload bodies, credentials or stack traces.
 */
export async function recordJobFailure(database: Database, queue: string, job: Job | undefined, error: Error): Promise<void> {
  if (!job?.id) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return; // will be retried
  const data = job.data as Record<string, unknown>;
  const providerEventId = typeof data["providerEventId"] === "string" ? data["providerEventId"] : null;
  await database.query.insert(schema.processingFailures).values({
    queue, jobId: job.id, providerEventId, errorCode: error.name.slice(0, 64), errorMessage: error.message.slice(0, 500), safeContext: { jobName: job.name, ...(providerEventId ? { providerEventId } : {}) }, attemptCount: job.attemptsMade,
  }).onConflictDoUpdate({ target: [schema.processingFailures.queue, schema.processingFailures.jobId], set: { errorCode: error.name.slice(0, 64), errorMessage: error.message.slice(0, 500), attemptCount: job.attemptsMade, failedAt: new Date() } });
  if (providerEventId) await database.query.update(schema.providerEvents).set({ status: "FAILED", lastErrorCode: error.name.slice(0, 64) }).where(eq(schema.providerEvents.id, providerEventId));
}
