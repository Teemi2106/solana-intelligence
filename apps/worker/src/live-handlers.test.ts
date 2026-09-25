import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HeliusBlockchainProvider, normalizeHeliusTransaction, type HeliusTransaction } from "@swi/blockchain";
import { FIXTURE_WALLET, loadWalletFixtures } from "@swi/blockchain/fixtures";
import { schema, type Database } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import type { FinalityProvider, FinalityStatus, LiveSubscriptionProvider, TokenLaunchProvider, WalletAddress } from "@swi/domain";
import { normalizeLiveEvent, persistHistoricalTransaction, recordLiveEvents } from "@swi/ingestion";
import { CachingHistoricalPriceProvider, CoinbaseSolUsdProvider, RoutingHistoricalPriceProvider } from "@swi/market-data";
import { MetricsRegistry } from "@swi/observability";
import {
  FINALITY_FIRST_DELAY_MS, FINALITY_RETRY_DELAY_MS, handleFinalityCheck, handleGapBackfill, handleNormalizeLiveEvent, handleReconcileSubscriptions, handleSweep, handleTokenLaunchEnrichment, handleWalletRecompute,
  type LiveHandlerDependencies, type LiveScheduler,
} from "./live-handlers.js";
import { PostgresPriceStore } from "./price-store.js";
import { rebuildWalletAccounting } from "./wallet-accounting.js";
import { updateWalletIntelligence } from "./wallet-intelligence.js";

const context = await createTestDatabase();
const secondContext = await createTestDatabase();
afterAll(async () => {
  await context?.dispose();
  await secondContext?.dispose();
});
const fixtures = loadWalletFixtures();
const ASOF = new Date("2026-09-25T12:00:00Z");

class RecordingScheduler implements LiveScheduler {
  readonly calls: { kind: string; args: unknown[] }[] = [];
  private record(kind: string, ...args: unknown[]) { this.calls.push({ kind, args }); return Promise.resolve(); }
  normalize(ids: readonly string[]) { return this.record("normalize", ids); }
  recompute(walletId: string, mode: "price-only" | "full", delayMs?: number) { return this.record("recompute", walletId, mode, delayMs); }
  finalityCheck(signature: string, attempt: number, delayMs: number) { return this.record("finality", signature, attempt, delayMs); }
  gapBackfill(walletId: string) { return this.record("gap", walletId); }
  enrichLaunchFacts(walletId: string) { return this.record("enrich", walletId); }
  of(kind: string) { return this.calls.filter((call) => call.kind === kind); }
}

/** Fake Coinbase serving deterministic candles: open = 100 + minute % 7. */
function fakeCoinbase() {
  return vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const start = Math.floor(Date.parse(url.searchParams.get("start") ?? "") / 60_000);
    const end = Math.floor(Date.parse(url.searchParams.get("end") ?? "") / 60_000);
    const rows = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => [(start + index) * 60, 1, 2, 100 + ((start + index) % 7), 100, 1]);
    return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
  });
}
const priceStack = (database: Database) => {
  const upstream = fakeCoinbase();
  const provider = new RoutingHistoricalPriceProvider([new CachingHistoricalPriceProvider(new CoinbaseSolUsdProvider({ fetch: upstream, sleep: () => Promise.resolve(), now: () => 0 }), new PostgresPriceStore(database))]);
  return { provider, upstream };
};

const finalityProvider = (status: FinalityStatus): FinalityProvider => ({ getFinality: (signatures) => Promise.resolve(new Map(signatures.map((signature) => [signature, status]))) });

async function reset(database: Database) {
  await database.sql`truncate tracked_wallets, provider_events, tokens, processing_failures, provider_subscriptions, provider_sync_runs, historical_price_points restart identity cascade`;
}
async function addWallet(database: Database, historyCompleted = true) {
  const [wallet] = await database.query.insert(schema.trackedWallets).values({ address: FIXTURE_WALLET }).returning();
  if (!wallet) throw new Error("wallet");
  if (historyCompleted) await database.query.insert(schema.walletIngestionRuns).values({ walletId: wallet.id, idempotencyKey: `t:${wallet.id}`, status: "COMPLETED" });
  return wallet.id;
}
const fingerprint = async (database: Database) => {
  const trades = await database.sql<{ x: string }[]>`select w.signature||':'||t.side||':'||t.raw_token_amount||':'||coalesce(t.raw_base_amount::text,'')||':'||coalesce(t.estimated_usd_value::text,'')||':'||coalesce(t.fee_usd::text,'')||':'||t.pricing_state||':'||coalesce(t.pricing_confidence_bps::text,'') as x from wallet_trades t join wallet_transactions w on w.id=t.transaction_id order by 1`;
  const lots = await database.sql<{ x: string }[]>`select w.signature||':'||l.acquired_raw_amount||':'||l.remaining_raw_amount||':'||coalesce(l.cost_basis_usd::text,'')||':'||coalesce(l.remaining_cost_basis_usd::text,'') as x from wallet_inventory_lots l join wallet_trades t on t.id=l.source_trade_id join wallet_transactions w on w.id=t.transaction_id order by 1`;
  const realizations = await database.sql<{ x: string }[]>`select sw.signature||'<-'||lw.signature||':'||r.raw_amount||':'||coalesce(r.realized_pnl_usd::text,'')||':'||coalesce(r.cost_basis_usd::text,'') as x from wallet_realizations r join wallet_trades st on st.id=r.sell_trade_id join wallet_transactions sw on sw.id=st.transaction_id join wallet_inventory_lots l on l.id=r.lot_id join wallet_trades lt on lt.id=l.source_trade_id join wallet_transactions lw on lw.id=lt.transaction_id order by 1`;
  const positions = await database.sql<{ x: string }[]>`select k.mint||':'||p.raw_amount||':'||coalesce(p.known_cost_basis_usd::text,'') as x from wallet_positions p join tokens k on k.id=p.token_id order by 1`;
  return JSON.stringify({ trades: trades.map((row) => row.x), lots: lots.map((row) => row.x), realizations: realizations.map((row) => row.x), positions: positions.map((row) => row.x) });
};

describe.skipIf(!context)("live handlers", () => {
  const database = () => requireDatabase(context);
  let scheduler: RecordingScheduler;
  let metrics: MetricsRegistry;
  const deps = (overrides: Partial<LiveHandlerDependencies> = {}): LiveHandlerDependencies => ({ database: database(), scheduler, metrics, liveEnabled: true, now: () => ASOF, ...overrides });
  beforeEach(async () => {
    await reset(database());
    scheduler = new RecordingScheduler();
    metrics = new MetricsRegistry();
  });
  const recordOne = async (transaction: HeliusTransaction) => (await recordLiveEvents(database(), [transaction])).accepted[0]?.id ?? "";

  describe("live path scheduling", () => {
    it("schedules a finality check per new transaction and price-only recompute per wallet, never a full rebuild", async () => {
      const walletId = await addWallet(database());
      const result = await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      expect(result.outcome).toBe("PROCESSED");
      expect(scheduler.of("finality").map((call) => call.args)).toEqual([[fixtures.pumpAmmBuy.signature, 0, FINALITY_FIRST_DELAY_MS]]);
      expect(scheduler.of("recompute").map((call) => call.args.slice(0, 2))).toEqual([[walletId, "price-only"]]);
    });

    it("does not reschedule anything for a transaction that already existed", async () => {
      const walletId = await addWallet(database());
      await database().query.transaction((transaction) => persistHistoricalTransaction(transaction, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmBuy)));
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      expect(scheduler.calls).toEqual([]);
    });
  });

  describe("finality handling", () => {
    it("finalized -> schedules a full recompute for the affected wallet", async () => {
      const walletId = await addWallet(database());
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      scheduler.calls.length = 0;
      const outcome = await handleFinalityCheck(deps({ finality: finalityProvider("FINALIZED") }), { signature: fixtures.pumpAmmBuy.signature, attempt: 0 });
      expect(outcome.status).toBe("FINALIZED");
      expect(scheduler.of("recompute").map((call) => call.args.slice(0, 2))).toEqual([[walletId, "full"]]);
    });

    it("still confirmed -> retries later with the next attempt number, and gives up after the cap", async () => {
      await addWallet(database());
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      scheduler.calls.length = 0;
      await handleFinalityCheck(deps({ finality: finalityProvider("CONFIRMED") }), { signature: fixtures.pumpAmmBuy.signature, attempt: 3 });
      expect(scheduler.of("finality").map((call) => call.args)).toEqual([[fixtures.pumpAmmBuy.signature, 4, FINALITY_RETRY_DELAY_MS]]);
      scheduler.calls.length = 0;
      await handleFinalityCheck(deps({ finality: finalityProvider("CONFIRMED") }), { signature: fixtures.pumpAmmBuy.signature, attempt: 39 });
      expect(scheduler.of("finality")).toEqual([]);
    });

    it("a provider timeout fails the job (so the queue retries) and changes no state", async () => {
      await addWallet(database());
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      const timeout: FinalityProvider = { getFinality: () => Promise.reject(Object.assign(new Error("Helius RPC is temporarily unavailable"), { code: "TIMEOUT", retryable: true })) };
      await expect(handleFinalityCheck(deps({ finality: timeout }), { signature: fixtures.pumpAmmBuy.signature, attempt: 0 })).rejects.toThrow("temporarily unavailable");
      expect((await database().query.select().from(schema.walletTransactions))[0]?.finality).toBe("confirmed");
    });

    it("a missing finality provider is a configuration error, not silent success", async () => {
      await addWallet(database());
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      await expect(handleFinalityCheck(deps(), { signature: fixtures.pumpAmmBuy.signature, attempt: 0 })).rejects.toThrow("FINALITY_PROVIDER_NOT_CONFIGURED");
    });
  });

  describe("live pricing", () => {
    it("prices confirmed trades from their own SOL flow and reuses the persisted price instead of refetching", async () => {
      await addWallet(database());
      const { provider, upstream } = priceStack(database());
      await handleNormalizeLiveEvent(deps({ prices: provider }), await recordOne(fixtures.pumpAmmBuy));
      await handleWalletRecompute(deps({ prices: provider }), { walletId: (await database().query.select().from(schema.trackedWallets))[0]?.id ?? "", mode: "price-only" });
      const [trade] = await database().query.select().from(schema.walletTrades);
      expect(trade).toMatchObject({ pricingState: "PRICED_FROM_SOL_FLOW", valuationBasis: "DERIVED", pricingSource: "SOL_FLOW:coinbase-exchange" });
      expect(trade?.priceObservationId).not.toBeNull();
      const requestsAfterFirst = upstream.mock.calls.length;
      expect(requestsAfterFirst).toBe(1);

      // Same minute, other trade: served from the persisted cache.
      await handleNormalizeLiveEvent(deps({ prices: provider }), await recordOne(fixtures.pumpAmmBuyNewAta));
      const walletId = (await database().query.select().from(schema.trackedWallets))[0]?.id ?? "";
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "price-only" });
      // Already priced trades are not repriced on replay.
      const before = JSON.stringify(await database().query.select().from(schema.walletTrades));
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "price-only" });
      expect(JSON.stringify(await database().query.select().from(schema.walletTrades))).toBe(before);
      const pointsBefore = (await database().sql<{ n: number }[]>`select count(*)::int as n from historical_price_points`)[0]?.n;
      expect(pointsBefore).toBeGreaterThan(0);
    });

    it("does not call the price provider at all when the transaction economics already price the trade", async () => {
      const walletId = await addWallet(database());
      const { provider, upstream } = priceStack(database());
      // A USDC-funded buy where the wallet did not pay the network fee: stablecoin flow, no SOL/USD needed.
      const usdcMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
      const base = normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmBuy);
      await database().query.transaction(async (transaction) => {
        const { persistNormalizedTransaction } = await import("@swi/ingestion");
        const [event] = await transaction.insert(schema.providerEvents).values({ provider: "helius", externalEventId: "helius:live:usdc", payloadHash: "x", eventType: "LIVE_TRANSACTION", payloadSummary: {} }).returning();
        await persistNormalizedTransaction(transaction, {
          walletId, providerEventId: event?.id ?? "", source: "helius-webhook", finality: "confirmed",
          chainTransaction: { ...base, feePayerIsWallet: false, nativeSolDeltaLamports: 0n, settlement: { ...base.settlement, counterpartyWsolDeltaLamports: null }, tokenFlows: [{ mint: usdcMint as never, direction: "OUT", rawAmount: 25_000_000n, decimals: 6, account: null, counterparty: null }, { mint: base.tokenFlows[0]?.mint as never, direction: "IN", rawAmount: 9_000_000n, decimals: 6, account: null, counterparty: null }] },
        });
      });
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "price-only" });
      expect((await database().query.select().from(schema.walletTrades))[0]).toMatchObject({ pricingState: "PRICED_FROM_STABLECOIN_FLOW", valuationBasis: "EXACT", estimatedUsdValue: "25.000000000000000000" });
      expect(upstream).not.toHaveBeenCalled();
    });

    it("retries a trade whose SOL/USD was unavailable once the provider recovers", async () => {
      const walletId = await addWallet(database());
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmBuy));
      const down = new RoutingHistoricalPriceProvider([new CachingHistoricalPriceProvider(new CoinbaseSolUsdProvider({ fetch: vi.fn<typeof fetch>().mockRejectedValue(new DOMException("t", "TimeoutError")), sleep: () => Promise.resolve(), now: () => 0 }), new PostgresPriceStore(database()))]);
      await handleWalletRecompute(deps({ prices: down }), { walletId, mode: "price-only" });
      expect((await database().query.select().from(schema.walletTrades))[0]).toMatchObject({ pricingState: "MISSING_QUOTE_USD_PRICE", estimatedUsdValue: null });
      expect((await database().sql<{ n: number }[]>`select count(*)::int as n from historical_price_points`)[0]?.n).toBe(0);
      await handleWalletRecompute(deps({ prices: priceStack(database()).provider }), { walletId, mode: "price-only" });
      expect((await database().query.select().from(schema.walletTrades))[0]).toMatchObject({ pricingState: "PRICED_FROM_SOL_FLOW" });
    });
  });

  describe("accounting from live data", () => {
    it("confirmed trades never become inventory; finalized ones do", async () => {
      const walletId = await addWallet(database());
      const { provider } = priceStack(database());
      for (const transaction of fixtures.replaySet.slice(0, 10)) await handleNormalizeLiveEvent(deps({ prices: provider }), await recordOne(transaction));
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "price-only" });
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      expect((await database().sql<{ n: number }[]>`select count(*)::int as n from wallet_inventory_lots`)[0]?.n).toBe(0);
      for (const transaction of fixtures.replaySet.slice(0, 10)) await handleFinalityCheck(deps({ finality: finalityProvider("FINALIZED") }), { signature: transaction.signature, attempt: 0 });
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      const buys = (await database().query.select().from(schema.walletTrades)).filter((trade) => trade.side === "BUY").length;
      expect((await database().sql<{ n: number }[]>`select count(*)::int as n from wallet_inventory_lots`)[0]?.n).toBe(buys);
    });

    it("a dropped transaction is excluded from accounting permanently", async () => {
      const walletId = await addWallet(database());
      const { provider } = priceStack(database());
      await handleNormalizeLiveEvent(deps({ prices: provider }), await recordOne(fixtures.pumpAmmBuy));
      await handleFinalityCheck(deps({ finality: finalityProvider("FAILED") }), { signature: fixtures.pumpAmmBuy.signature, attempt: 0 });
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      expect((await database().sql<{ n: number }[]>`select count(*)::int as n from wallet_inventory_lots`)[0]?.n).toBe(0);
    });

    it("withholds the score and writes one stable classification version for a small sample", async () => {
      const walletId = await addWallet(database());
      const { provider } = priceStack(database());
      const finalize = async () => { for (const transaction of fixtures.replaySet.slice(0, 15)) await handleFinalityCheck(deps({ finality: finalityProvider("FINALIZED") }), { signature: transaction.signature, attempt: 0 }); };
      for (const transaction of fixtures.replaySet.slice(0, 15)) await handleNormalizeLiveEvent(deps({ prices: provider }), await recordOne(transaction));
      await finalize();
      const first = await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      expect(first.intelligence?.score).toBeNull();
      expect(first.intelligence?.scoreEligibility.eligible).toBe(false);
      expect((await database().query.select().from(schema.walletScores)).length).toBe(0);
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      expect((await database().query.select().from(schema.walletClassifications)).length).toBe(1);
      // Snapshots are append-only and only written when the observation changed.
      const snapshots = (await database().query.select().from(schema.walletPerformanceSnapshots)).length;
      await handleWalletRecompute(deps({ prices: provider }), { walletId, mode: "full" });
      expect((await database().query.select().from(schema.walletPerformanceSnapshots)).length).toBe(snapshots);
    });
  });

  describe("recovery and maintenance", () => {
    it("the sweeper requeues stuck events and unchecked confirmed transactions", async () => {
      await addWallet(database());
      const stuck = await recordOne(fixtures.pumpAmmBuy);
      await database().sql`update provider_events set received_at = now() - interval '10 minutes' where id = ${stuck}`;
      await handleNormalizeLiveEvent(deps(), await recordOne(fixtures.pumpAmmSell));
      await database().sql`update wallet_transactions set first_seen_at = now() - interval '10 minutes' where signature = ${fixtures.pumpAmmSell.signature}`;
      scheduler.calls.length = 0;
      expect(await handleSweep(deps({ now: () => new Date() }))).toEqual({ eventsRequeued: 1, finalityRequeued: 1 });
      expect(scheduler.of("normalize")[0]?.args[0]).toEqual([stuck]);
      expect(scheduler.of("finality")[0]?.args).toEqual([fixtures.pumpAmmSell.signature, 0, 0]);
    });

    it("a crash after persisting but before queueing loses nothing: sweep then normalize completes the event", async () => {
      const walletId = await addWallet(database());
      const [event] = (await recordLiveEvents(database(), [fixtures.pumpAmmBuy])).accepted;
      await database().sql`update provider_events set received_at = now() - interval '5 minutes' where id = ${event?.id ?? ""}`;
      await handleSweep(deps({ now: () => new Date() }));
      const ids = scheduler.of("normalize")[0]?.args[0] as string[];
      for (const id of ids) await handleNormalizeLiveEvent(deps(), id);
      expect((await database().query.select().from(schema.walletTransactions))[0]).toMatchObject({ walletId, signature: fixtures.pumpAmmBuy.signature });
    });

    it("gap backfill schedules a recompute only when it recovered something", async () => {
      const walletId = await addWallet(database());
      const request = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify([fixtures.pumpAmmBuy]), { status: 200 })));
      const history = new HeliusBlockchainProvider({ apiKey: "k", fetch: request });
      expect((await handleGapBackfill(deps({ history }), walletId)).transactionsCreated).toBe(1);
      expect(scheduler.of("recompute").map((call) => call.args.slice(0, 2))).toEqual([[walletId, "full"]]);
      scheduler.calls.length = 0;
      expect((await handleGapBackfill(deps({ history }), walletId)).transactionsCreated).toBe(0);
      expect(scheduler.calls).toEqual([]);
    });
  });

  describe("feature flag", () => {
    it("with live ingestion disabled, reconciliation touches no provider and schedules nothing", async () => {
      await addWallet(database());
      const provider: LiveSubscriptionProvider = new Proxy({} as LiveSubscriptionProvider, { get: () => { throw new Error("provider must not be used"); } });
      const result = await handleReconcileSubscriptions(deps({ liveEnabled: false, subscriptions: provider }));
      expect(result.outcome).toBe("SKIPPED_DISABLED");
      expect(scheduler.calls).toEqual([]);
      expect(await database().query.select().from(schema.providerSyncRuns)).toEqual([]);
    });

    it("schedules gap backfills for newly monitored wallets when enabled", async () => {
      const walletId = await addWallet(database());
      const state = { externalId: "wh_1", webhookUrl: "u", addresses: [] as string[], active: true };
      const provider: LiveSubscriptionProvider = {
        maxAddresses: 10, findSubscription: () => Promise.resolve(null), checkHealth: () => Promise.resolve({ name: "x", status: "up", latencyMs: 1 }), setActive: () => Promise.resolve(state),
        createSubscription: (addresses) => Promise.resolve({ ...state, addresses: [...addresses] }), replaceAddresses: (_id, addresses) => Promise.resolve({ ...state, addresses: [...addresses] }),
      };
      await handleReconcileSubscriptions(deps({ subscriptions: provider }));
      expect(scheduler.of("gap").map((call) => call.args)).toEqual([[walletId]]);
    });
  });

  describe("token launch enrichment", () => {
    it("stores launch facts, records unavailable answers, leaves provider errors retryable, and triggers a recompute", async () => {
      const walletId = await addWallet(database());
      const historical = fixtures.replaySet;
      for (const transaction of historical) await database().query.transaction((tx) => persistHistoricalTransaction(tx, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, transaction)));
      const mints = (await database().sql<{ mint: string }[]>`select distinct k.mint from wallet_trades t join tokens k on k.id = t.token_id order by 1`).map((row) => row.mint);
      expect(mints.length).toBeGreaterThanOrEqual(3);
      const launch: TokenLaunchProvider = {
        getFirstActivity: (mint) => {
          if (mint === mints[0]) return Promise.resolve({ status: "FOUND", firstActivityAt: new Date("2026-08-01T00:00:00Z"), firstActivitySlot: 1n, firstSignature: "sig", firstSigner: "Deployer111" });
          if (mint === mints[1]) return Promise.resolve({ status: "UNAVAILABLE", reason: "NO_ACTIVITY_FOUND" });
          return Promise.reject(new Error("rate limited"));
        },
      };
      const result = await handleTokenLaunchEnrichment(deps({ launch }), walletId);
      expect(result).toMatchObject({ found: 1, unavailable: 1 });
      expect(result.errors).toBe(mints.length - 2);
      expect(result.requested).toBe(mints.length);
      const facts = await database().query.select().from(schema.tokenLaunchFacts);
      expect(facts.map((fact) => fact.status).sort()).toEqual(["FOUND", "UNAVAILABLE"]);
      expect(scheduler.of("recompute").map((call) => call.args.slice(0, 2))).toEqual([[walletId, "full"]]);
      expect(scheduler.of("enrich")).toHaveLength(1); // errored tokens come back later
    });
  });
});

describe.skipIf(!context || !secondContext)("deterministic replay", () => {
  it("live delivery (shuffled, duplicated, finalized later) yields the same accounting as historical ingestion", async () => {
    const historicalDb = requireDatabase(context);
    const liveDb = requireDatabase(secondContext);
    for (const database of [historicalDb, liveDb]) await reset(database);
    const set = fixtures.replaySet;

    const historicalWallet = await addWallet(historicalDb);
    for (const transaction of set) await historicalDb.query.transaction((tx) => persistHistoricalTransaction(tx, historicalWallet, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, transaction)));
    const historicalPrices = priceStack(historicalDb).provider;
    const historicalScheduler = new RecordingScheduler();
    await handleWalletRecompute({ database: historicalDb, scheduler: historicalScheduler, metrics: new MetricsRegistry(), liveEnabled: false, prices: historicalPrices }, { walletId: historicalWallet, mode: "full" }, ASOF);

    const liveWallet = await addWallet(liveDb);
    const livePrices = priceStack(liveDb).provider;
    const liveScheduler = new RecordingScheduler();
    const liveDeps: LiveHandlerDependencies = { database: liveDb, scheduler: liveScheduler, metrics: new MetricsRegistry(), liveEnabled: true, prices: livePrices, finality: finalityProvider("FINALIZED") };
    const shuffled = [...set].sort((a, b) => a.signature.localeCompare(b.signature));
    // Duplicate deliveries and a late redelivery of the oldest events.
    for (const transaction of [...shuffled, ...shuffled.slice(0, 10), ...shuffled.slice(-5)]) {
      const recorded = await recordLiveEvents(liveDb, [transaction]);
      for (const event of recorded.accepted) await normalizeLiveEvent({ database: liveDb }, event.id);
    }
    for (const transaction of shuffled) await handleFinalityCheck(liveDeps, { signature: transaction.signature, attempt: 0 });
    await handleWalletRecompute(liveDeps, { walletId: liveWallet, mode: "full" }, ASOF);
    await handleWalletRecompute(liveDeps, { walletId: liveWallet, mode: "full" }, ASOF);

    const historical = await fingerprint(historicalDb);
    expect(historical).toBe(await fingerprint(liveDb));
    expect((JSON.parse(historical) as { lots: string[] }).lots.length).toBeGreaterThan(0);
    // Rebuilding again is stable.
    await rebuildWalletAccounting({ database: liveDb, prices: livePrices }, liveWallet, ASOF);
    expect(await fingerprint(liveDb)).toBe(historical);
  });
});

describe.skipIf(!context)("versioned scores and classifications", () => {
  const database = () => requireDatabase(context);

  it("never edits a historical score: changed inputs close the old row and append a new one", async () => {
    await reset(database());
    const walletId = await addWallet(database());
    const { provider } = priceStack(database());
    for (const transaction of fixtures.replaySet) await database().query.transaction((tx) => persistHistoricalTransaction(tx, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, transaction)));
    const accounting = await (async () => {
      const { priceWalletTrades } = await import("./wallet-accounting.js");
      await priceWalletTrades({ database: database(), prices: provider }, walletId);
      return rebuildWalletAccounting({ database: database(), prices: provider }, walletId, ASOF);
    })();
    const eligible = (days: number, sales: number) => ({ windowDays: days, eligible: true, reasons: [], totalSales: sales, qualifyingSales: sales, coverageBps: 10_000, metrics: { realizedPnlUsd: "1000", completedTrades: sales, profitableTrades: 26, losingTrades: 14, winRateBps: 6500, medianRoi: "0.2", averageRoi: "0.3", averageHoldingSeconds: 300, medianHoldingSeconds: 250, largestWinnerUsd: "150", largestLoserUsd: "-80", profitableTokenCount: 20, largestTradeContribution: "0.15", profitExcludingLargestUsd: "850", maxDrawdownUsd: "200", peakCumulativePnlUsd: "1000", quality: "HIGH" as const } });
    const windows = [eligible(7, 10), eligible(30, 25), eligible(90, 40)];
    const run = (at: Date) => updateWalletIntelligence({ database: database() }, { walletId, address: FIXTURE_WALLET, windows, evidenceInputs: { ...accounting.evidenceInputs, meanQualifyingConfidenceBps: 9000 }, asOf: at });
    const mints = accounting.evidenceInputs.tokenMints;
    expect(mints.length).toBeGreaterThan(2);

    // 1. No launch facts: copyability cannot be established, so the score is withheld.
    const withheld = await run(new Date("2026-09-25T12:00:00Z"));
    expect(withheld.score).toBeNull();
    expect(withheld.scoreEligibility.reasons).toContain("COPYABILITY_INPUTS_NOT_AVAILABLE");
    expect(await database().query.select().from(schema.walletScores)).toEqual([]);

    // 2. Launch facts exist for every token, all long before the wallet's entries: fully copyable.
    const tokens = await database().query.select().from(schema.tokens);
    for (const token of tokens) await database().query.insert(schema.tokenLaunchFacts).values({ tokenId: token.id, status: "FOUND", firstActivityAt: new Date("2026-08-01T00:00:00Z"), firstSigner: "Deployer111", source: "test" });
    const scored = await run(new Date("2026-09-25T13:00:00Z"));
    expect(scored.score).not.toBeNull();
    expect(scored.copyability.copyableTradeRatioBps).toBe(10_000);
    const [first] = await database().query.select().from(schema.walletScores);
    expect(first).toMatchObject({ validTo: null });

    // 3. Identical inputs: nothing new is written.
    await run(new Date("2026-09-25T14:00:00Z"));
    expect(await database().query.select().from(schema.walletScores)).toHaveLength(1);

    // 4. One entry becomes non-copyable: the old row is closed untouched, and a new version is appended.
    const entry = accounting.evidenceInputs.entryTrades[0];
    const firstEntryToken = tokens.find((token) => token.mint === entry?.tokenMint);
    await database().query.update(schema.tokenLaunchFacts).set({ firstActivityAt: new Date((entry?.occurredAt.getTime() ?? 0) - 5_000) }).where((await import("drizzle-orm")).eq(schema.tokenLaunchFacts.tokenId, firstEntryToken?.id ?? ""));
    const changed = await run(new Date("2026-09-25T15:00:00Z"));
    expect(changed.copyability.copyableTradeRatioBps).toBeLessThan(10_000);
    const versions = (await database().query.select().from(schema.walletScores)).sort((a, b) => a.validFrom.getTime() - b.validFrom.getTime());
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({ id: first?.id, value: first?.value, validTo: new Date("2026-09-25T15:00:00Z") });
    expect(versions[0]?.inputs).toEqual(first?.inputs);
    expect(versions[1]?.validTo).toBeNull();
    const nonCopyable = await database().query.select().from(schema.walletClassificationEvidence);
    expect(nonCopyable.some((row) => row.evidenceType === "NON_COPYABLE_ENTRY")).toBe(true);

    // 5. Evidence disappears: the active score is closed rather than left standing.
    await database().sql`delete from token_launch_facts`;
    const gone = await run(new Date("2026-09-25T16:00:00Z"));
    expect(gone.score).toBeNull();
    expect((await database().query.select().from(schema.walletScores)).filter((row) => row.validTo === null)).toEqual([]);
  });
});

describe.skipIf(!context)("deployer-linked transfer evidence", () => {
  it("records a neutral fact when a token was received by transfer from the address that signed its first transaction", async () => {
    const database = requireDatabase(context);
    await reset(database);
    const walletId = await addWallet(database);
    const { persistHistoricalTransaction: persist } = await import("@swi/ingestion");
    await database.query.transaction((tx) => persist(tx, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.tokenTransfer)));
    const [receipt] = await database.sql<{ mint: string; counterparty: string }[]>`select k.mint, f.counterparty from transaction_token_flows f join tokens k on k.id = f.token_id where f.direction = 'IN' and f.counterparty is not null`;
    expect(receipt).toBeDefined();
    const [token] = await database.query.select().from(schema.tokens).where(eq(schema.tokens.mint, receipt?.mint ?? ""));
    await database.query.insert(schema.tokenLaunchFacts).values({ tokenId: token?.id ?? "", status: "FOUND", firstActivityAt: new Date("2026-08-01T00:00:00Z"), firstSigner: receipt?.counterparty ?? "", source: "test" });
    const result = await updateWalletIntelligence({ database }, {
      walletId, address: FIXTURE_WALLET, windows: [], asOf: ASOF,
      evidenceInputs: { entryTrades: [], saleAllocations: [], tokenMints: [receipt?.mint ?? ""], meanQualifyingConfidenceBps: null },
    });
    const evidence = await database.query.select().from(schema.walletClassificationEvidence);
    expect(evidence.map((row) => row.evidenceType)).toEqual(["DEPLOYER_LINKED_TRANSFER"]);
    expect(evidence[0]?.facts).toMatchObject({ tokenMint: receipt?.mint, sender: receipt?.counterparty });
    expect(evidence[0]?.observedAt).toBeInstanceOf(Date);
    // One receipt is a fact, not a pattern: no early-access label from a single token.
    expect(result.classification).toBe("UNKNOWN_INSUFFICIENT_EVIDENCE");
  });
});
