import { and, eq, isNotNull, notInArray, sql } from "drizzle-orm";
import type { LiveSubscriptionProvider, LiveSubscriptionState } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import type { MetricsRegistry } from "@swi/observability";

const PROVIDER = "helius";
const KIND = "wallet-activity-webhook";

export type SyncOutcome = "NO_CHANGE" | "CREATED" | "UPDATED" | "REACTIVATED" | "DEACTIVATED" | "SKIPPED_DISABLED" | "SKIPPED_NO_WALLETS";

export interface SyncResult {
  readonly outcome: SyncOutcome;
  readonly desired: number;
  readonly providerBefore: number;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** Wallets the provider is now confirmed to watch that it was not watching before (need a gap backfill). */
  readonly newlyMonitoredWalletIds: readonly string[];
}

const sameSet = (left: readonly string[], right: readonly string[]) => left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Reconciles the provider subscription with desired state. The database (ACTIVE tracked wallets) is the source of
 * truth; the provider is read, diffed and only written when it differs, because management calls cost credits.
 * Every write is verified by a read-back. Failures are recorded and re-thrown so the job retries with backoff.
 */
export async function reconcileSubscriptions(dependencies: { database: Database; provider: LiveSubscriptionProvider; enabled: boolean; metrics?: MetricsRegistry; now?: () => Date }): Promise<SyncResult> {
  const { database, provider } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  if (!dependencies.enabled) return { outcome: "SKIPPED_DISABLED", desired: 0, providerBefore: 0, added: [], removed: [], newlyMonitoredWalletIds: [] };

  const wallets = await database.query.select({ id: schema.trackedWallets.id, address: schema.trackedWallets.address }).from(schema.trackedWallets).where(eq(schema.trackedWallets.status, "ACTIVE"));
  const desired = wallets.map((wallet) => wallet.address).sort();
  const idByAddress = new Map(wallets.map((wallet) => [wallet.address, wallet.id]));
  const [run] = await database.query.insert(schema.providerSyncRuns).values({ provider: PROVIDER, startedAt, outcome: "RUNNING", desiredCount: desired.length }).returning({ id: schema.providerSyncRuns.id });

  let state: LiveSubscriptionState | null = null;
  let before: readonly string[] = [];
  try {
    state = await provider.findSubscription();
    before = state?.addresses ?? [];
    let outcome: SyncOutcome = "NO_CHANGE";
    if (state === null) {
      if (desired.length === 0) outcome = "SKIPPED_NO_WALLETS";
      else {
        state = await provider.createSubscription(desired);
        outcome = "CREATED";
      }
    } else {
      if (!sameSet(state.addresses, desired) && desired.length > 0) {
        state = await provider.replaceAddresses(state.externalId, desired);
        outcome = "UPDATED";
      }
      if (desired.length > 0 && !state.active) {
        state = await provider.setActive(state.externalId, true);
        outcome = outcome === "NO_CHANGE" ? "REACTIVATED" : outcome;
      } else if (desired.length === 0 && state.active) {
        // The provider rejects an empty address list, so pause deliveries instead.
        state = await provider.setActive(state.externalId, false);
        outcome = "DEACTIVATED";
      }
    }
    // Trust but verify: a write only counts once the provider reports the desired set.
    if (state !== null && desired.length > 0 && !sameSet(state.addresses, desired)) throw new SyncError("SYNC_VERIFICATION_FAILED");

    const confirmed = state !== null && state.active && desired.length > 0;
    const added = confirmed ? desired.filter((address) => !before.includes(address)) : [];
    const removed = before.filter((address) => !desired.includes(address));
    const confirmedAt = now();
    await database.query.transaction(async (transaction) => {
      if (state) {
        await transaction.insert(schema.providerSubscriptions).values({ provider: PROVIDER, kind: KIND, externalId: state.externalId, status: "IN_SYNC", desiredAddressCount: desired.length, providerAddressCount: state.addresses.length, lastSyncedAt: confirmedAt })
          .onConflictDoUpdate({ target: [schema.providerSubscriptions.provider, schema.providerSubscriptions.kind], set: { externalId: state.externalId, status: state.active || desired.length === 0 ? "IN_SYNC" : "DISABLED_BY_PROVIDER", desiredAddressCount: desired.length, providerAddressCount: state.addresses.length, lastSyncedAt: confirmedAt, lastErrorCode: null, updatedAt: confirmedAt } });
      }
      const monitored = confirmed ? wallets.map((wallet) => wallet.id) : [];
      for (const walletId of monitored) {
        await transaction.insert(schema.walletLiveMonitoring).values({ walletId, providerConfirmedAt: confirmedAt }).onConflictDoUpdate({ target: schema.walletLiveMonitoring.walletId, set: { providerConfirmedAt: sql`coalesce(${schema.walletLiveMonitoring.providerConfirmedAt}, ${confirmedAt.toISOString()}::timestamptz)`, updatedAt: confirmedAt } });
      }
      // Wallets no longer desired stop being "confirmed monitored".
      if (monitored.length > 0) await transaction.update(schema.walletLiveMonitoring).set({ providerConfirmedAt: null, updatedAt: confirmedAt }).where(notInArray(schema.walletLiveMonitoring.walletId, monitored));
      else await transaction.update(schema.walletLiveMonitoring).set({ providerConfirmedAt: null, updatedAt: confirmedAt });
      if (run) await transaction.update(schema.providerSyncRuns).set({ finishedAt: confirmedAt, outcome, added: added.length, removed: removed.length, providerCount: state?.addresses.length ?? 0 }).where(eq(schema.providerSyncRuns.id, run.id));
    });
    dependencies.metrics?.increment("provider_sync_total", { outcome });
    return { outcome, desired: desired.length, providerBefore: before.length, added, removed, newlyMonitoredWalletIds: added.flatMap((address) => idByAddress.get(address) ?? []) };
  } catch (error) {
    const code = error instanceof SyncError ? error.code : (error as { code?: string }).code ?? (error instanceof Error ? error.name : "UNKNOWN");
    if (run) await database.query.update(schema.providerSyncRuns).set({ finishedAt: now(), outcome: "FAILED", errorCode: code, providerCount: before.length }).where(eq(schema.providerSyncRuns.id, run.id));
    await database.query.insert(schema.providerSubscriptions).values({ provider: PROVIDER, kind: KIND, externalId: state?.externalId ?? null, status: "ERROR", desiredAddressCount: desired.length, providerAddressCount: before.length, lastErrorCode: code })
      .onConflictDoUpdate({ target: [schema.providerSubscriptions.provider, schema.providerSubscriptions.kind], set: { status: "ERROR", desiredAddressCount: desired.length, lastErrorCode: code, updatedAt: now() } });
    dependencies.metrics?.increment("provider_sync_total", { outcome: "failed" });
    throw error;
  }
}

export class SyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SyncError";
  }
}

/** Wallets currently confirmed as watched by the provider (used for dashboards). */
export async function countMonitoredWallets(database: Database): Promise<number> {
  const rows = await database.query.select({ id: schema.walletLiveMonitoring.walletId }).from(schema.walletLiveMonitoring).innerJoin(schema.trackedWallets, eq(schema.trackedWallets.id, schema.walletLiveMonitoring.walletId))
    .where(and(eq(schema.trackedWallets.status, "ACTIVE"), isNotNull(schema.walletLiveMonitoring.providerConfirmedAt)));
  return rows.length;
}
