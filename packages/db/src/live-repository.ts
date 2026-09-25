import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "./client";
import { processingFailures, providerEvents, providerSubscriptions, providerSyncRuns, systemHealth, tokens, trackedWallets, walletLiveMonitoring, walletTrades, walletTransactions } from "./schema/index";

export interface WalletActivityRow {
  readonly transactionId: string;
  readonly signature: string;
  readonly occurredAt: Date;
  readonly firstSeenAt: Date;
  readonly finality: string;
  readonly ingestionSource: string;
  readonly kind: string;
  readonly succeeded: boolean;
  readonly processingState: string | null;
  readonly side: "BUY" | "SELL" | null;
  readonly tokenMint: string | null;
  readonly tokenSymbol: string | null;
  readonly tokenDecimals: number | null;
  readonly rawTokenAmount: string | null;
  readonly quoteMint: string | null;
  readonly rawQuoteAmount: string | null;
  readonly quoteDecimals: number | null;
  readonly considerationUsd: string | null;
  readonly pricingState: string | null;
  readonly pricingConfidenceBps: number | null;
  readonly routed: boolean | null;
  readonly venue: string | null;
}

/** Latest observed activity for one wallet, newest first: BUY / SELL where a trade was reconstructed, otherwise the transaction kind. */
export async function getWalletActivity(database: Database, walletId: string, limit = 25): Promise<WalletActivityRow[]> {
  const rows = await database.query.select({ tx: walletTransactions, trade: walletTrades, token: tokens, eventStatus: providerEvents.status })
    .from(walletTransactions)
    .innerJoin(providerEvents, eq(providerEvents.id, walletTransactions.providerEventId))
    .leftJoin(walletTrades, eq(walletTrades.transactionId, walletTransactions.id))
    .leftJoin(tokens, eq(tokens.id, walletTrades.tokenId))
    .where(and(eq(walletTransactions.walletId, walletId), ne(walletTransactions.kind, "OTHER")))
    .orderBy(desc(walletTransactions.occurredAt), desc(walletTransactions.slot))
    .limit(limit);
  return rows.map(({ tx, trade, token, eventStatus }) => ({
    transactionId: tx.id, signature: tx.signature, occurredAt: tx.occurredAt, firstSeenAt: tx.firstSeenAt, finality: tx.finality, ingestionSource: tx.ingestionSource, kind: tx.kind, succeeded: tx.succeeded,
    processingState: eventStatus, side: trade?.side ?? null, tokenMint: token?.mint ?? null, tokenSymbol: token?.symbol ?? null, tokenDecimals: trade?.tokenDecimals ?? null,
    rawTokenAmount: trade?.rawTokenAmount ?? null, quoteMint: trade?.baseMint ?? null, rawQuoteAmount: trade?.rawBaseAmount ?? null, quoteDecimals: trade?.baseDecimals ?? null,
    considerationUsd: trade?.estimatedUsdValue ?? null, pricingState: trade?.pricingState ?? null, pricingConfidenceBps: trade?.pricingConfidenceBps ?? null, routed: trade?.routed ?? null, venue: trade?.venue ?? null,
  }));
}

export async function getWalletLiveState(database: Database, walletId: string) {
  const [row] = await database.query.select().from(walletLiveMonitoring).where(eq(walletLiveMonitoring.walletId, walletId)).limit(1);
  return row ?? null;
}

export interface LiveSystemStatus {
  readonly activeWallets: number;
  readonly monitoredWallets: number;
  readonly lastWebhookReceivedAt: Date | null;
  readonly eventsLastHour: Readonly<Record<string, number>>;
  readonly latencyMs: { readonly averageMs: number | null; readonly p95Ms: number | null; readonly samples: number };
  readonly finality: Readonly<Record<string, number>>;
  readonly unresolvedFailures: number;
  readonly recentFailures: readonly { readonly queue: string; readonly jobId: string; readonly errorCode: string; readonly attemptCount: number; readonly failedAt: Date }[];
  readonly subscription: { readonly status: string; readonly externalIdSuffix: string | null; readonly desiredAddressCount: number; readonly providerAddressCount: number; readonly lastSyncedAt: Date | null; readonly lastErrorCode: string | null } | null;
  readonly lastSyncRun: { readonly outcome: string; readonly startedAt: Date; readonly finishedAt: Date | null; readonly errorCode: string | null; readonly added: number; readonly removed: number } | null;
  readonly worker: { readonly status: string; readonly heartbeatAt: Date; readonly liveEnabled: boolean | null } | null;
}

export async function getLiveSystemStatus(database: Database, now: Date = new Date()): Promise<LiveSystemStatus> {
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [active, monitored, last, byStatus, latency, finality, failures, unresolved, subscription, lastRun, worker] = await Promise.all([
    database.query.select({ value: sql<number>`count(*)::int` }).from(trackedWallets).where(eq(trackedWallets.status, "ACTIVE")),
    database.sql<{ value: number }[]>`select count(*)::int as value from wallet_live_monitoring m join tracked_wallets w on w.id = m.wallet_id where w.status = 'ACTIVE' and m.provider_confirmed_at is not null`,
    database.sql<{ at: string | Date | null }[]>`select max(received_at) as at from provider_events where event_type = 'LIVE_TRANSACTION'`,
    database.sql<{ status: string; value: number }[]>`select status, count(*)::int as value from provider_events where event_type = 'LIVE_TRANSACTION' and received_at >= ${hourAgo.toISOString()}::timestamptz group by status`,
    database.sql<{ average: number | null; p95: number | null; samples: number }[]>`
      select avg(extract(epoch from (processed_at - received_at)) * 1000)::float as average,
             percentile_cont(0.95) within group (order by extract(epoch from (processed_at - received_at)) * 1000)::float as p95,
             count(*)::int as samples
      from provider_events where event_type = 'LIVE_TRANSACTION' and status = 'PROCESSED' and processed_at is not null and received_at >= ${hourAgo.toISOString()}::timestamptz`,
    database.sql<{ finality: string; value: number }[]>`select finality, count(*)::int as value from wallet_transactions where first_seen_at >= ${dayAgo.toISOString()}::timestamptz and ingestion_source = 'helius-webhook' group by finality`,
    database.query.select().from(processingFailures).where(isNull(processingFailures.resolvedAt)).orderBy(desc(processingFailures.failedAt)).limit(5),
    database.query.select({ value: sql<number>`count(*)::int` }).from(processingFailures).where(isNull(processingFailures.resolvedAt)),
    database.query.select().from(providerSubscriptions).where(eq(providerSubscriptions.provider, "helius")).limit(1),
    database.query.select().from(providerSyncRuns).where(eq(providerSyncRuns.provider, "helius")).orderBy(desc(providerSyncRuns.startedAt)).limit(1),
    database.query.select().from(systemHealth).where(eq(systemHealth.component, "worker")).limit(1),
  ]);
  const sub = subscription[0];
  const run = lastRun[0];
  const health = worker[0];
  const latencyRow = latency[0];
  return {
    activeWallets: active[0]?.value ?? 0,
    monitoredWallets: monitored[0]?.value ?? 0,
    // Raw SQL timestamps arrive as strings from the drizzle postgres driver; normalize them.
    lastWebhookReceivedAt: last[0]?.at ? new Date(last[0].at) : null,
    eventsLastHour: Object.fromEntries(byStatus.map((row) => [row.status, row.value])),
    latencyMs: { averageMs: latencyRow?.average ?? null, p95Ms: latencyRow?.p95 ?? null, samples: latencyRow?.samples ?? 0 },
    finality: Object.fromEntries(finality.map((row) => [row.finality, row.value])),
    unresolvedFailures: unresolved[0]?.value ?? 0,
    recentFailures: failures.map((failure) => ({ queue: failure.queue, jobId: failure.jobId, errorCode: failure.errorCode, attemptCount: failure.attemptCount, failedAt: failure.failedAt })),
    subscription: sub ? { status: sub.status, externalIdSuffix: sub.externalId ? sub.externalId.slice(-6) : null, desiredAddressCount: sub.desiredAddressCount, providerAddressCount: sub.providerAddressCount, lastSyncedAt: sub.lastSyncedAt, lastErrorCode: sub.lastErrorCode } : null,
    lastSyncRun: run ? { outcome: run.outcome, startedAt: run.startedAt, finishedAt: run.finishedAt, errorCode: run.errorCode, added: run.added, removed: run.removed } : null,
    worker: health ? { status: health.status, heartbeatAt: health.heartbeatAt, liveEnabled: typeof health.details["liveEnabled"] === "boolean" ? health.details["liveEnabled"] : null } : null,
  };
}
