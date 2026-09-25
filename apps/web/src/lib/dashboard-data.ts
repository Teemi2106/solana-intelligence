import "server-only";
import { count, desc, eq, schema } from "@swi/db";
import { getDatabase } from "./database";

export async function getDashboardSummary() {
  const db = getDatabase().query;
  const [wallets, events, signals, recentSignals] = await Promise.all([
    db.select({ value: count() }).from(schema.trackedWallets).where(eq(schema.trackedWallets.status, "ACTIVE")),
    db.select({ value: count() }).from(schema.providerEvents),
    db.select({ value: count() }).from(schema.signals),
    db.select({ id: schema.signals.id, type: schema.signals.type, level: schema.signals.level, score: schema.signals.score, detectedAt: schema.signals.detectedAt, symbol: schema.tokens.symbol, mint: schema.tokens.mint })
      .from(schema.signals).innerJoin(schema.tokens, eq(schema.signals.tokenId, schema.tokens.id)).orderBy(desc(schema.signals.detectedAt)).limit(8),
  ]);
  return { monitoredWallets: wallets[0]?.value ?? 0, eventsProcessed: events[0]?.value ?? 0, signalsGenerated: signals[0]?.value ?? 0, recentSignals };
}
