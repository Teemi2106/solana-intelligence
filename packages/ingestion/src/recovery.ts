import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";

export interface RecoveryScanObservation {
  readonly status: string;
  readonly pages: number;
  readonly transactionsSeen: number;
  readonly transactionsCreated: number;
}

export async function createShadowRecoveryWindow(dependencies: {
  database: Database;
  walletIds: readonly string[];
  reason: string;
  unhealthyFrom: Date;
  healthyAt?: Date;
}): Promise<string | null> {
  if (dependencies.walletIds.length === 0) return null;
  const [window] = await dependencies.database.query.insert(schema.liveRecoveryWindows).values({
    scope: dependencies.walletIds.length === 1 ? "WALLET" : "SUBSCRIPTION",
    reason: dependencies.reason,
    unhealthyFrom: dependencies.unhealthyFrom,
    healthyAt: dependencies.healthyAt ?? null,
    status: "SHADOW_OBSERVING",
    shadow: "true",
  }).returning({ id: schema.liveRecoveryWindows.id });
  if (!window) throw new Error("RECOVERY_WINDOW_INSERT_FAILED");
  await dependencies.database.query.insert(schema.liveRecoveryTasks).values(dependencies.walletIds.map((walletId) => ({
    windowId: window.id,
    walletId,
    status: "SHADOW_PENDING",
  }))).onConflictDoNothing({ target: [schema.liveRecoveryTasks.windowId, schema.liveRecoveryTasks.walletId] });
  return window.id;
}

/** Stable jitter spreads integrity work over the configured interval without process-local scheduling state. */
export function integrityJitterMs(walletId: string, intervalMs: number): number {
  let hash = 2_166_136_261;
  for (const character of walletId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % intervalMs;
}

/** Seeds durable schedules, then records (but does not execute) the work the listener-first model would perform. */
export async function planShadowIntegrityRecovery(dependencies: {
  database: Database;
  intervalMs: number;
  metrics?: MetricsRegistry;
  now?: () => Date;
  limit?: number;
}): Promise<{ seeded: number; planned: number; windowId: string | null }> {
  const now = (dependencies.now ?? (() => new Date()))();
  const wallets = await dependencies.database.query.select({ id: schema.walletLiveMonitoring.walletId })
    .from(schema.walletLiveMonitoring)
    .innerJoin(schema.trackedWallets, eq(schema.trackedWallets.id, schema.walletLiveMonitoring.walletId))
    .leftJoin(schema.walletRecoveryCheckpoints, eq(schema.walletRecoveryCheckpoints.walletId, schema.walletLiveMonitoring.walletId))
    .where(and(
      eq(schema.trackedWallets.status, "ACTIVE"),
      isNotNull(schema.walletLiveMonitoring.providerConfirmedAt),
      // Drizzle's nullable left-join column is represented by a null wallet id when no checkpoint exists.
      lte(schema.walletRecoveryCheckpoints.nextIntegrityCheckAt, now),
    ))
    .limit(dependencies.limit ?? 250);

  const unseeded = await dependencies.database.sql<{ wallet_id: string }[]>`
    select m.wallet_id
    from wallet_live_monitoring m
    join tracked_wallets w on w.id = m.wallet_id
    left join wallet_recovery_checkpoints c on c.wallet_id = m.wallet_id
    where w.status = 'ACTIVE' and m.provider_confirmed_at is not null and c.wallet_id is null
  `;
  for (const wallet of unseeded) {
    await dependencies.database.query.insert(schema.walletRecoveryCheckpoints).values({
      walletId: wallet.wallet_id,
      nextIntegrityCheckAt: new Date(now.getTime() + integrityJitterMs(wallet.wallet_id, dependencies.intervalMs)),
    }).onConflictDoNothing({ target: schema.walletRecoveryCheckpoints.walletId });
  }

  if (wallets.length === 0) {
    dependencies.metrics?.increment("recovery_shadow_plans_total", { outcome: "empty" });
    return { seeded: unseeded.length, planned: 0, windowId: null };
  }
  const [window] = await dependencies.database.query.insert(schema.liveRecoveryWindows).values({
    scope: "INTEGRITY",
    reason: "SCHEDULED_INTEGRITY",
    unhealthyFrom: now,
    healthyAt: now,
    status: "SHADOW_OBSERVING",
    shadow: "true",
    details: { intervalMs: dependencies.intervalMs },
  }).returning({ id: schema.liveRecoveryWindows.id });
  if (!window) throw new Error("RECOVERY_WINDOW_INSERT_FAILED");
  await dependencies.database.query.insert(schema.liveRecoveryTasks).values(wallets.map((wallet) => ({
    windowId: window.id,
    walletId: wallet.id,
    status: "SHADOW_PENDING",
  }))).onConflictDoNothing({ target: [schema.liveRecoveryTasks.windowId, schema.liveRecoveryTasks.walletId] });
  await dependencies.database.query.update(schema.walletRecoveryCheckpoints).set({
    nextIntegrityCheckAt: new Date(now.getTime() + dependencies.intervalMs),
    updatedAt: now,
  }).where(inArray(schema.walletRecoveryCheckpoints.walletId, wallets.map((wallet) => wallet.id)));
  dependencies.metrics?.increment("recovery_shadow_plans_total", { outcome: "planned" });
  dependencies.metrics?.increment("recovery_shadow_wallets_total", {}, wallets.length);
  return { seeded: unseeded.length, planned: wallets.length, windowId: window.id };
}

/** Attaches a real legacy backfill result to pending shadow tasks for comparison without executing duplicate work. */
export async function observeShadowRecovery(database: Database, walletId: string, result: RecoveryScanObservation, now: Date = new Date()): Promise<number> {
  const pending = await database.query.select({ id: schema.liveRecoveryTasks.id, windowId: schema.liveRecoveryTasks.windowId })
    .from(schema.liveRecoveryTasks)
    .where(and(eq(schema.liveRecoveryTasks.walletId, walletId), eq(schema.liveRecoveryTasks.status, "SHADOW_PENDING")))
    .orderBy(desc(schema.liveRecoveryTasks.createdAt));
  if (pending.length === 0) return 0;
  for (const task of pending) {
    await database.query.update(schema.liveRecoveryTasks).set({
      status: result.status === "COMPLETED" ? "SHADOW_OBSERVED" : "SHADOW_INCOMPLETE",
      pages: result.pages,
      transactionsSeen: result.transactionsSeen,
      transactionsCreated: result.transactionsCreated,
      completedAt: now,
      updatedAt: now,
    }).where(eq(schema.liveRecoveryTasks.id, task.id));
  }
  for (const windowId of new Set(pending.map((task) => task.windowId))) {
    const [remaining] = await database.query.select({ id: schema.liveRecoveryTasks.id }).from(schema.liveRecoveryTasks)
      .where(and(eq(schema.liveRecoveryTasks.windowId, windowId), eq(schema.liveRecoveryTasks.status, "SHADOW_PENDING"))).limit(1);
    if (!remaining) await database.query.update(schema.liveRecoveryWindows).set({ status: "SHADOW_COMPLETED", updatedAt: now }).where(eq(schema.liveRecoveryWindows.id, windowId));
  }
  return pending.length;
}

export async function recordVerifiedRecoveryCheckpoint(dependencies: {
  database: Database;
  walletId: string;
  scanStartedAt: Date;
  verifiedThroughAt: Date;
  anchor?: { signature: string; slot: bigint };
  result: RecoveryScanObservation;
  intervalMs: number;
}): Promise<void> {
  const [existing] = await dependencies.database.query.select({ nextIntegrityCheckAt: schema.walletRecoveryCheckpoints.nextIntegrityCheckAt })
    .from(schema.walletRecoveryCheckpoints).where(eq(schema.walletRecoveryCheckpoints.walletId, dependencies.walletId)).limit(1);
  // Hourly legacy scans must not perpetually postpone the independent shadow schedule. The planner moves the deadline
  // only when a wallet is actually due; a newly created checkpoint gets a stable initial jitter.
  const nextIntegrityCheckAt = existing?.nextIntegrityCheckAt
    ?? new Date(dependencies.scanStartedAt.getTime() + integrityJitterMs(dependencies.walletId, dependencies.intervalMs));
  await dependencies.database.query.insert(schema.walletRecoveryCheckpoints).values({
    walletId: dependencies.walletId,
    verifiedThroughAt: dependencies.verifiedThroughAt,
    verifiedThroughSlot: dependencies.anchor?.slot ?? null,
    anchorSignature: dependencies.anchor?.signature ?? null,
    lastScanStartedAt: dependencies.scanStartedAt,
    lastScanCompletedAt: new Date(),
    lastScanStatus: dependencies.result.status,
    lastScanPages: dependencies.result.pages,
    lastScanTransactionsSeen: dependencies.result.transactionsSeen,
    lastScanTransactionsCreated: dependencies.result.transactionsCreated,
    consecutiveFailures: 0,
    nextIntegrityCheckAt,
  }).onConflictDoUpdate({ target: schema.walletRecoveryCheckpoints.walletId, set: {
    verifiedThroughAt: dependencies.verifiedThroughAt,
    verifiedThroughSlot: dependencies.anchor?.slot ?? null,
    anchorSignature: dependencies.anchor?.signature ?? null,
    lastScanStartedAt: dependencies.scanStartedAt,
    lastScanCompletedAt: new Date(),
    lastScanStatus: dependencies.result.status,
    lastScanPages: dependencies.result.pages,
    lastScanTransactionsSeen: dependencies.result.transactionsSeen,
    lastScanTransactionsCreated: dependencies.result.transactionsCreated,
    consecutiveFailures: 0,
    nextIntegrityCheckAt,
    updatedAt: new Date(),
  } });
}

/** Records a failed attempt without moving the verified boundary or the next integrity deadline. */
export async function recordRecoveryScanFailure(database: Database, walletId: string, scanStartedAt: Date, errorCode: string): Promise<void> {
  const [existing] = await database.query.select().from(schema.walletRecoveryCheckpoints).where(eq(schema.walletRecoveryCheckpoints.walletId, walletId)).limit(1);
  if (!existing) {
    await database.query.insert(schema.walletRecoveryCheckpoints).values({
      walletId,
      lastScanStartedAt: scanStartedAt,
      lastScanCompletedAt: new Date(),
      lastScanStatus: `FAILED:${errorCode.slice(0, 64)}`,
      consecutiveFailures: 1,
      nextIntegrityCheckAt: scanStartedAt,
    }).onConflictDoNothing({ target: schema.walletRecoveryCheckpoints.walletId });
    return;
  }
  await database.query.update(schema.walletRecoveryCheckpoints).set({
    lastScanStartedAt: scanStartedAt,
    lastScanCompletedAt: new Date(),
    lastScanStatus: `FAILED:${errorCode.slice(0, 64)}`,
    consecutiveFailures: existing.consecutiveFailures + 1,
    updatedAt: new Date(),
  }).where(eq(schema.walletRecoveryCheckpoints.walletId, walletId));
}

