import "server-only";
import { count, desc, eq, listTrackedWallets, schema } from "@swi/db";
import { and, gte } from "drizzle-orm";
import { getDatabase } from "./database";

export async function getDashboardSummary() {
  const db = getDatabase().query;
  const since = new Date(Date.now() - 86_400_000);
  const [wallets, events, transactions24h, signals, recentSignals, recentActivity, trackedWallets] = await Promise.all([
    db.select({ value: count() }).from(schema.trackedWallets).where(eq(schema.trackedWallets.status, "ACTIVE")),
    db.select({ value: count() }).from(schema.providerEvents).where(eq(schema.providerEvents.status, "PROCESSED")),
    db.select({ value: count() }).from(schema.walletTransactions).where(and(eq(schema.walletTransactions.ingestionSource, "helius-webhook"), gte(schema.walletTransactions.occurredAt, since))),
    db.select({ value: count() }).from(schema.signals),
    db.select({ id: schema.signals.id, type: schema.signals.type, level: schema.signals.level, score: schema.signals.score, detectedAt: schema.signals.detectedAt, symbol: schema.tokens.symbol, mint: schema.tokens.mint })
      .from(schema.signals).innerJoin(schema.tokens, eq(schema.signals.tokenId, schema.tokens.id)).orderBy(desc(schema.signals.detectedAt)).limit(8),
    db.select({ id: schema.walletTransactions.id, kind: schema.walletTransactions.kind, signature: schema.walletTransactions.signature, occurredAt: schema.walletTransactions.occurredAt, finality: schema.walletTransactions.finality, address: schema.trackedWallets.address, displayName: schema.trackedWallets.displayName })
      .from(schema.walletTransactions).innerJoin(schema.trackedWallets, eq(schema.walletTransactions.walletId, schema.trackedWallets.id))
      .where(eq(schema.walletTransactions.ingestionSource, "helius-webhook")).orderBy(desc(schema.walletTransactions.occurredAt)).limit(24),
    listTrackedWallets(getDatabase()),
  ]);
  return { monitoredWallets: wallets[0]?.value ?? 0, eventsProcessed: events[0]?.value ?? 0, transactions24h: transactions24h[0]?.value ?? 0, signalsGenerated: signals[0]?.value ?? 0, recentSignals, recentActivity,
    wallets: trackedWallets.slice(0, 8).map((wallet) => ({ id: wallet.id, address: wallet.address, displayName: wallet.displayName, status: wallet.status, score: wallet.score?.value ?? null, classification: wallet.classification?.classification ?? null, transactionsStored: wallet.ingestion?.transactionsStored ?? 0 })),
  };
}
