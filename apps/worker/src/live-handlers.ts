import { and, eq, isNotNull } from "drizzle-orm";
import type { BlockchainProvider, FinalityProvider, HistoricalPriceProvider, LiveSubscriptionProvider, NotificationProvider, TokenLaunchProvider } from "@swi/domain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import {
  backfillWalletGap, checkSignatureFinality, findStuckEvents, findUncheckedConfirmed, FINALITY_MAX_ATTEMPTS, normalizeLiveEvent, reconcileSubscriptions,
} from "@swi/ingestion";
import type { MetricsRegistry } from "@swi/observability";
import { ensureTokenLaunchFacts, updateWalletIntelligence } from "./wallet-intelligence.js";
import { priceWalletTrades, rebuildWalletAccounting } from "./wallet-accounting.js";

/** What handlers may schedule. In production this is backed by BullMQ; tests can record or execute the calls. */
export interface LiveScheduler {
  normalize(providerEventIds: readonly string[]): Promise<void>;
  recompute(walletId: string, mode: "price-only" | "full", delayMs?: number): Promise<void>;
  finalityCheck(signature: string, attempt: number, delayMs: number): Promise<void>;
  gapBackfill(walletId: string): Promise<void>;
  enrichLaunchFacts(walletId: string): Promise<void>;
}

export interface LiveHandlerDependencies {
  readonly database: Database;
  readonly scheduler: LiveScheduler;
  readonly metrics: MetricsRegistry;
  readonly now?: () => Date;
  readonly liveEnabled: boolean;
  readonly history?: BlockchainProvider;
  readonly subscriptions?: LiveSubscriptionProvider;
  readonly finality?: FinalityProvider;
  readonly launch?: TokenLaunchProvider;
  readonly prices?: HistoricalPriceProvider;
  readonly liveNotifier?: NotificationProvider;
  readonly logger?: { warn(context: Readonly<Record<string, unknown>>, message: string): void };
}

const need = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`${name}_NOT_CONFIGURED`);
  return value;
};

/** First finality check after the confirmed event is stored, and the spacing between later ones. */
export const FINALITY_FIRST_DELAY_MS = 45_000;
export const FINALITY_RETRY_DELAY_MS = 30_000;

export async function handleNormalizeLiveEvent(dependencies: LiveHandlerDependencies, providerEventId: string) {
  const result = await normalizeLiveEvent({ database: dependencies.database, metrics: dependencies.metrics, ...(dependencies.now ? { now: dependencies.now } : {}) }, providerEventId);
  const wallets = new Set<string>();
  for (const item of result.affected) {
    if (item.created) await dependencies.scheduler.finalityCheck(item.signature, 0, FINALITY_FIRST_DELAY_MS);
    if (item.tradesCreated > 0) wallets.add(item.walletId);
    if (item.created && dependencies.liveNotifier) {
      try {
        await dependencies.liveNotifier.deliver({
          deduplicationKey: `phase3-live:${item.walletId}:${item.signature}`,
          severity: "INFO",
          text: liveActivityMessage(item),
        });
      } catch (error) {
        dependencies.logger?.warn({
          operation: "telegram-live-diagnostic",
          providerEventId,
          walletId: item.walletId,
          signature: short(item.signature),
          errorName: error instanceof Error ? error.name : "UnknownError",
        }, "live diagnostic notification failed");
      }
    }
  }
  // Pricing only: confirmed trades are shown live but do not feed accounting until finalized.
  for (const walletId of wallets) await dependencies.scheduler.recompute(walletId, "price-only");
  return result;
}

const short = (value: string): string => value.length <= 16 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;

export function liveActivityMessage(item: { walletAddress: string; transactionType: string; signature: string; occurredAt: Date }): string {
  return [
    "🎲 Degen Scout — Live Wallet Activity",
    "",
    `Wallet: ${short(item.walletAddress)}`,
    `Type: ${item.transactionType}`,
    `Signature: ${short(item.signature)}`,
    "Status: Processed live",
    `Time: ${item.occurredAt.toISOString()}`,
    "",
    "Live pipeline confirmed ✅",
  ].join("\n");
}

export async function handleFinalityCheck(dependencies: LiveHandlerDependencies, input: { signature: string; attempt: number }) {
  const outcome = await checkSignatureFinality({ database: dependencies.database, provider: need(dependencies.finality, "FINALITY_PROVIDER"), metrics: dependencies.metrics, ...(dependencies.now ? { now: dependencies.now } : {}) }, input.signature);
  if (outcome.status === "PENDING" && input.attempt + 1 < FINALITY_MAX_ATTEMPTS) await dependencies.scheduler.finalityCheck(input.signature, input.attempt + 1, FINALITY_RETRY_DELAY_MS);
  if (outcome.status === "FINALIZED" || outcome.status === "DROPPED") for (const walletId of new Set(outcome.walletIds)) await dependencies.scheduler.recompute(walletId, "full");
  return outcome;
}

export async function handleReconcileSubscriptions(dependencies: LiveHandlerDependencies) {
  const result = await reconcileSubscriptions({ database: dependencies.database, provider: need(dependencies.subscriptions, "SUBSCRIPTION_PROVIDER"), enabled: dependencies.liveEnabled, metrics: dependencies.metrics, ...(dependencies.now ? { now: dependencies.now } : {}) });
  // Anything that was not watched a moment ago may have traded in the gap.
  for (const walletId of result.newlyMonitoredWalletIds) await dependencies.scheduler.gapBackfill(walletId);
  return result;
}

export async function handleGapBackfill(dependencies: LiveHandlerDependencies, walletId: string) {
  const result = await backfillWalletGap({ database: dependencies.database, provider: need(dependencies.history, "HISTORY_PROVIDER"), metrics: dependencies.metrics, ...(dependencies.now ? { now: dependencies.now } : {}) }, walletId);
  if (result.transactionsCreated > 0) await dependencies.scheduler.recompute(walletId, "full");
  return result;
}

/** Crash recovery: re-enqueue persisted-but-unprocessed events and confirmed transactions without a recent finality check. */
export async function handleSweep(dependencies: LiveHandlerDependencies) {
  const now = (dependencies.now ?? (() => new Date()))();
  const stuck = await findStuckEvents(dependencies.database, { now, olderThanMs: 60_000, processingTimeoutMs: 300_000, limit: 500 });
  if (stuck.length > 0) await dependencies.scheduler.normalize(stuck);
  const unchecked = await findUncheckedConfirmed(dependencies.database, { now, olderThanMs: 120_000, limit: 200 });
  for (const signature of unchecked) await dependencies.scheduler.finalityCheck(signature, 0, 0);
  dependencies.metrics.increment("sweeper_requeued_total", { kind: "events" }, stuck.length);
  dependencies.metrics.increment("sweeper_requeued_total", { kind: "finality" }, unchecked.length);
  return { eventsRequeued: stuck.length, finalityRequeued: unchecked.length };
}

/** Schedules a gap backfill for every active wallet the provider is confirmed to watch (periodic safety net for lost deliveries). */
export async function handleGapScan(dependencies: LiveHandlerDependencies) {
  const wallets = await dependencies.database.query.select({ id: schema.walletLiveMonitoring.walletId }).from(schema.walletLiveMonitoring)
    .innerJoin(schema.trackedWallets, eq(schema.trackedWallets.id, schema.walletLiveMonitoring.walletId))
    .where(and(eq(schema.trackedWallets.status, "ACTIVE"), isNotNull(schema.walletLiveMonitoring.providerConfirmedAt)));
  for (const wallet of wallets) await dependencies.scheduler.gapBackfill(wallet.id);
  return { scheduled: wallets.length };
}

/**
 * Prices pending trades, and in `full` mode rebuilds accounting from finalized trades, then derives evidence, score and
 * classification. Deterministic: the result depends only on persisted rows and persisted price observations.
 */
export async function handleWalletRecompute(dependencies: LiveHandlerDependencies, input: { walletId: string; mode: "price-only" | "full" }, asOf: Date = (dependencies.now ?? (() => new Date()))()) {
  const prices = need(dependencies.prices, "PRICE_PROVIDER");
  const pricing = await priceWalletTrades({ database: dependencies.database, prices }, input.walletId, { onlyPending: true });
  for (const [state, count] of Object.entries(pricing.byState)) dependencies.metrics.increment("live_pricing_total", { state }, count);
  if (input.mode === "price-only") return { pricing, accounting: null, intelligence: null };

  const accounting = await rebuildWalletAccounting({ database: dependencies.database, prices }, input.walletId, asOf);
  const [wallet] = await dependencies.database.query.select().from(schema.trackedWallets).where(eq(schema.trackedWallets.id, input.walletId)).limit(1);
  if (!wallet) return { pricing, accounting, intelligence: null };
  const intelligence = await updateWalletIntelligence({ database: dependencies.database }, { walletId: wallet.id, address: wallet.address, windows: accounting.windows, evidenceInputs: accounting.evidenceInputs, asOf });
  // Launch facts arrive from an external provider, so they are fetched by a separate job and the recompute is repeated afterwards.
  if (dependencies.launch && intelligence.copyability.coverageBps !== null && intelligence.copyability.entriesWithLaunchFacts < intelligence.copyability.entries) await dependencies.scheduler.enrichLaunchFacts(wallet.id);
  return { pricing, accounting, intelligence };
}

export async function handleTokenLaunchEnrichment(dependencies: LiveHandlerDependencies, walletId: string) {
  const launch = need(dependencies.launch, "LAUNCH_PROVIDER");
  const tokens = await dependencies.database.sql<{ mint: string }[]>`select distinct k.mint from wallet_trades t join tokens k on k.id = t.token_id where t.wallet_id = ${walletId}`;
  const result = await ensureTokenLaunchFacts({ database: dependencies.database, provider: launch, ...(dependencies.now ? { now: dependencies.now } : {}) }, tokens.map((token) => token.mint), { limit: 100 });
  dependencies.metrics.increment("token_launch_enrichment_total", { outcome: "found" }, result.found);
  dependencies.metrics.increment("token_launch_enrichment_total", { outcome: "error" }, result.errors);
  if (result.found > 0 || result.unavailable > 0) await dependencies.scheduler.recompute(walletId, "full", 0);
  // More tokens remain (rate-limited batch): come back for the rest.
  if (result.remaining > 0 && result.requested > 0) await dependencies.scheduler.enrichLaunchFacts(walletId);
  return result;
}
