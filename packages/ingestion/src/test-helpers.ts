import { FIXTURE_WALLET, type WalletFixtures } from "@swi/blockchain/fixtures";
import { heliusAuthHeaderValue } from "@swi/blockchain";
import type { Database } from "@swi/db";
import { schema } from "@swi/db";
import { MetricsRegistry } from "@swi/observability";
import type { RateLimiter, WebhookLogger } from "./webhook-handler";

export const SECRET = "w".repeat(48);
export { FIXTURE_WALLET };

export async function resetDatabase(database: Database): Promise<void> {
  await database.sql`truncate tracked_wallets, provider_events, tokens, processing_failures, provider_subscriptions, provider_sync_runs, historical_price_points restart identity cascade`;
}

export async function addWallet(database: Database, address = FIXTURE_WALLET, status: "ACTIVE" | "PAUSED" | "ARCHIVED" = "ACTIVE", options: { historyCompleted?: boolean } = {}): Promise<string> {
  const [wallet] = await database.query.insert(schema.trackedWallets).values({ address, status }).returning({ id: schema.trackedWallets.id });
  if (!wallet) throw new Error("wallet not created");
  if (options.historyCompleted) await database.query.insert(schema.walletIngestionRuns).values({ walletId: wallet.id, idempotencyKey: `test:${wallet.id}`, status: "COMPLETED" });
  return wallet.id;
}

export function webhookRequest(body: unknown, options: { secret?: string | null; headers?: Record<string, string>; raw?: string; method?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...options.headers };
  const secret = options.secret === undefined ? SECRET : options.secret;
  if (secret !== null) headers["authorization"] = heliusAuthHeaderValue(secret);
  return new Request("https://example.com/api/webhooks/helius", { method: options.method ?? "POST", headers, body: options.raw ?? JSON.stringify(body) });
}

export class MemoryLimiter implements RateLimiter {
  readonly counts = new Map<string, number>();
  fail = false;
  hit(key: string, limit: number): Promise<{ allowed: boolean }> {
    if (this.fail) return Promise.reject(new Error("redis down"));
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return Promise.resolve({ allowed: next <= limit });
  }
}

export function recordingLogger() {
  const lines: string[] = [];
  const push = (level: string) => (fields: Record<string, unknown>, message: string) => { lines.push(JSON.stringify({ level, message, ...fields })); };
  const logger: WebhookLogger = { info: push("info"), warn: push("warn"), error: push("error") };
  return { logger, lines };
}

export const newMetrics = () => new MetricsRegistry();

/** A delivery containing the given fixture transactions. */
export const delivery = (...transactions: WalletFixtures["pumpAmmBuy"][]) => transactions;
