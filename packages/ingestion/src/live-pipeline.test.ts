import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HeliusBlockchainProvider, heliusTransaction, normalizeHeliusTransaction, type HeliusTransaction } from "@swi/blockchain";
import { loadWalletFixtures } from "@swi/blockchain/fixtures";
import { schema } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import type { FinalityProvider, FinalityStatus, WalletAddress } from "@swi/domain";
import { checkSignatureFinality, findUncheckedConfirmed, FINALITY_DROP_AFTER_MS } from "./finality";
import { backfillWalletGap } from "./gap-backfill";
import { persistHistoricalTransaction } from "./historical";
import { findStuckEvents, normalizeLiveEvent, recordLiveEvents } from "./live-events";
import { addWallet, FIXTURE_WALLET, newMetrics, resetDatabase } from "./test-helpers";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());
const fixtures = loadWalletFixtures();

describe.skipIf(!context)("live ingestion pipeline", () => {
  const database = () => requireDatabase(context);
  beforeEach(async () => {
    await resetDatabase(database());
  });

  const ingest = async (...transactions: HeliusTransaction[]) => {
    const recorded = await recordLiveEvents(database(), transactions);
    const results = [];
    for (const event of recorded.accepted) results.push(await normalizeLiveEvent({ database: database() }, event.id));
    return { recorded, results };
  };
  const counts = async () => (await database().sql<{ tx: number; trades: number; flows: number }[]>`select (select count(*) from wallet_transactions)::int as tx, (select count(*) from wallet_trades)::int as trades, (select count(*) from transaction_token_flows)::int as flows`)[0] as { tx: number; trades: number; flows: number };
  const transactionRows = () => database().query.select().from(schema.walletTransactions);
  const tradeRows = () => database().query.select().from(schema.walletTrades);

  describe("normalization", () => {
    it("live SOL -> token creates one confirmed transaction and one BUY through the shared model", async () => {
      const walletId = await addWallet(database());
      const { results } = await ingest(fixtures.pumpAmmBuy);
      expect(results[0]?.outcome).toBe("PROCESSED");
      const [tx] = await transactionRows();
      expect(tx).toMatchObject({ walletId, finality: "confirmed", ingestionSource: "helius-webhook", succeeded: true, kind: "SWAP", signature: fixtures.pumpAmmBuy.signature });
      const [trade] = await tradeRows();
      expect(trade).toMatchObject({ side: "BUY", rawBaseAmount: "3300000000", considerationBasis: "EXACT", pricingState: "RECONSTRUCTED_UNPRICED", wsolNormalized: true });
      const [monitoring] = await database().query.select().from(schema.walletLiveMonitoring);
      expect(monitoring).toMatchObject({ walletId, lastSignature: fixtures.pumpAmmBuy.signature });
    });

    it("live token -> SOL creates a SELL with the exact proceeds", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmSell);
      expect(await tradeRows()).toMatchObject([{ side: "SELL", rawBaseAmount: "192852999409" }]);
    });

    it("stores transfers and unknown structures without creating trades", async () => {
      await addWallet(database());
      await ingest(fixtures.tokenTransfer, fixtures.systemTransfer);
      expect((await counts()).trades).toBe(0);
      expect((await transactionRows()).map((row) => row.kind).sort()).toEqual(["OTHER", "TRANSFER"]);
    });

    it("stores a failed transaction as failed without trades or flows", async () => {
      await addWallet(database());
      await ingest({ ...fixtures.pumpAmmBuy, transactionError: { InstructionError: [0, "Custom"] } });
      const [tx] = await transactionRows();
      expect(tx).toMatchObject({ succeeded: false, kind: "OTHER" });
      expect(await counts()).toMatchObject({ trades: 0, flows: 0 });
    });

    it("degrades an unsupported swap structure to AMBIGUOUS without inventing a trade", async () => {
      await addWallet(database());
      const extra = { account: "ExtraTokenAccount1111111111111111111111111111", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: FIXTURE_WALLET, tokenAccount: "ExtraTokenAccount1111111111111111111111111111", mint: "OtherMint11111111111111111111111111111111111", rawTokenAmount: { tokenAmount: "5", decimals: 6 } }] };
      await ingest({ ...fixtures.pumpAmmBuy, accountData: [...fixtures.pumpAmmBuy.accountData, extra] });
      expect((await transactionRows())[0]?.kind).toBe("AMBIGUOUS");
      expect((await counts()).trades).toBe(0);
    });

    it("ignores transactions that concern no active tracked wallet", async () => {
      await addWallet(database(), "SomeOtherWallet11111111111111111111111111111");
      await addWallet(database(), FIXTURE_WALLET, "PAUSED").catch(() => undefined);
      const { results } = await ingest(fixtures.pumpAmmBuy);
      expect(results[0]?.outcome).toBe("NO_TRACKED_WALLET");
      expect((await counts()).tx).toBe(0);
      const [event] = await database().query.select().from(schema.providerEvents);
      expect(event?.status).toBe("PROCESSED");
    });

    it("records the transaction for every tracked wallet it concerns", async () => {
      await addWallet(database());
      const counterparty = fixtures.pumpAmmBuy.accountData.flatMap((account) => account.tokenBalanceChanges).map((change) => change.userAccount).find((owner): owner is string => typeof owner === "string" && owner !== FIXTURE_WALLET);
      expect(counterparty).toBeDefined();
      await addWallet(database(), counterparty);
      await ingest(fixtures.pumpAmmBuy);
      expect((await counts()).tx).toBe(2);
    });

    it("marks a stored payload that no longer validates as failed instead of retrying forever", async () => {
      await addWallet(database());
      const [event] = await database().query.insert(schema.providerEvents).values({ provider: "helius", externalEventId: "helius:live:bad", payloadHash: "x", eventType: "LIVE_TRANSACTION", payloadSummary: {}, payload: { nonsense: true } }).returning();
      expect((await normalizeLiveEvent({ database: database() }, event?.id ?? "")).outcome).toBe("INVALID_PAYLOAD");
      expect((await database().query.select().from(schema.providerEvents))[0]).toMatchObject({ status: "FAILED", lastErrorCode: "PAYLOAD_INVALID" });
    });

    it("reports an unknown event id", async () => {
      expect((await normalizeLiveEvent({ database: database() }, "00000000-0000-4000-8000-000000000000")).outcome).toBe("NOT_FOUND");
    });
  });

  describe("idempotency", () => {
    it("processing the same event twice changes nothing", async () => {
      await addWallet(database());
      const recorded = await recordLiveEvents(database(), [fixtures.pumpAmmBuy]);
      const id = recorded.accepted[0]?.id ?? "";
      expect((await normalizeLiveEvent({ database: database() }, id)).outcome).toBe("PROCESSED");
      const before = await counts();
      expect((await normalizeLiveEvent({ database: database() }, id)).outcome).toBe("ALREADY_PROCESSED");
      expect(await counts()).toEqual(before);
    });

    it("concurrent workers on the same event converge on exactly one transaction and one trade", async () => {
      await addWallet(database());
      const [event] = (await recordLiveEvents(database(), [fixtures.pumpAmmBuy])).accepted;
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => normalizeLiveEvent({ database: database() }, event?.id ?? "")));
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect(await counts()).toMatchObject({ tx: 1, trades: 1 });
    });

    it("a redelivered transaction under a new provider event creates no duplicate trade", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      const [first] = await database().query.select().from(schema.providerEvents);
      // Simulates a webhook recreated/replayed with a different event identity for the same signature.
      const [second] = await database().query.insert(schema.providerEvents).values({ provider: "helius", externalEventId: `replay:${fixtures.pumpAmmBuy.signature}`, payloadHash: "y", eventType: "LIVE_TRANSACTION", payloadSummary: {}, payload: first?.payload ?? {} }).returning();
      await normalizeLiveEvent({ database: database() }, second?.id ?? "");
      expect(await counts()).toMatchObject({ tx: 1, trades: 1 });
    });

    it("a transaction already ingested historically creates no duplicate live trade and stays finalized", async () => {
      const walletId = await addWallet(database());
      await database().query.transaction((transaction) => persistHistoricalTransaction(transaction, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmBuy)));
      await ingest(fixtures.pumpAmmBuy);
      expect(await counts()).toMatchObject({ tx: 1, trades: 1 });
      expect((await transactionRows())[0]).toMatchObject({ finality: "finalized", ingestionSource: "helius-history" });
    });

    it("history arriving after the live event promotes it to finalized without duplicating anything", async () => {
      const walletId = await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      expect((await transactionRows())[0]?.finality).toBe("confirmed");
      await database().query.transaction((transaction) => persistHistoricalTransaction(transaction, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmBuy)));
      expect(await counts()).toMatchObject({ tx: 1, trades: 1 });
      expect((await transactionRows())[0]).toMatchObject({ finality: "finalized", ingestionSource: "helius-webhook" });
      expect((await transactionRows())[0]?.finalizedAt).not.toBeNull();
    });

    it("a live confirmation never downgrades a finalized transaction", async () => {
      const walletId = await addWallet(database());
      await database().query.transaction((transaction) => persistHistoricalTransaction(transaction, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmSell)));
      await ingest(fixtures.pumpAmmSell);
      expect((await transactionRows())[0]?.finality).toBe("finalized");
    });
  });

  describe("ordering", () => {
    const canonical = async () => {
      const rows = await database().sql<{ signature: string; side: string; raw: string; base: string }[]>`select w.signature, t.side, t.raw_token_amount as raw, t.raw_base_amount as base from wallet_trades t join wallet_transactions w on w.id = t.transaction_id order by w.signature, t.side`;
      return JSON.stringify(rows);
    };

    it("out-of-order and delayed events produce the same canonical rows as in-order delivery", async () => {
      const set = fixtures.replaySet.slice(0, 12);
      await addWallet(database());
      await ingest(...set);
      const inOrder = await canonical();
      await resetDatabase(database());
      await addWallet(database());
      const shuffled = [...set].sort((a, b) => a.signature.localeCompare(b.signature)).reverse();
      // Deliver the newest first, then the rest, then re-deliver one much older event late.
      await ingest(...shuffled);
      await ingest(...shuffled.slice(0, 2));
      expect(await canonical()).toBe(inOrder);
    });

    it("keeps the latest slot as the wallet's live position even when older events arrive later", async () => {
      await addWallet(database());
      const [older, newer] = [...fixtures.replaySet.slice(0, 2)].sort((a, b) => a.slot - b.slot) as [HeliusTransaction, HeliusTransaction];
      await ingest(newer);
      await ingest(older);
      const [monitoring] = await database().query.select().from(schema.walletLiveMonitoring);
      expect(monitoring?.lastSignature).toBe(newer.signature);
      expect(monitoring?.lastSlot).toBe(BigInt(newer.slot));
    });
  });

  describe("crash recovery", () => {
    it("finds events stuck before or during processing, and completes them idempotently", async () => {
      await addWallet(database());
      const { recorded } = await ingest();
      expect(recorded.accepted).toEqual([]);
      const stuck = await recordLiveEvents(database(), [fixtures.pumpAmmBuy, fixtures.pumpAmmSell, fixtures.pumpAmmBuyNewAta, fixtures.pumpAmmSellSmall]);
      const [received, queued, processing, fresh] = stuck.accepted.map((event) => event.id) as [string, string, string, string];
      const longAgo = new Date(Date.now() - 10 * 60_000);
      await database().sql`update provider_events set received_at = ${longAgo.toISOString()}::timestamptz, status = 'RECEIVED' where id = ${received}`;
      await database().sql`update provider_events set received_at = ${longAgo.toISOString()}::timestamptz, status = 'QUEUED' where id = ${queued}`;
      await database().sql`update provider_events set received_at = ${longAgo.toISOString()}::timestamptz, status = 'PROCESSING', attempt_count = 1 where id = ${processing}`;
      const found = await findStuckEvents(database(), { now: new Date(), olderThanMs: 60_000, processingTimeoutMs: 300_000, limit: 100 });
      expect([...found].sort()).toEqual([received, queued, processing].sort());
      expect(found).not.toContain(fresh);
      for (const id of found) await normalizeLiveEvent({ database: database() }, id);
      for (const id of found) await normalizeLiveEvent({ database: database() }, id);
      expect((await counts()).trades).toBe(3);
      expect(await findStuckEvents(database(), { now: new Date(), olderThanMs: 60_000, processingTimeoutMs: 300_000, limit: 100 })).toEqual([]);
    });

    it("a failure in the middle of processing rolls the wallet's write back and the retry succeeds", async () => {
      await addWallet(database());
      const [event] = (await recordLiveEvents(database(), [fixtures.pumpAmmBuy])).accepted;
      // Break the trade insert once: the enclosing transaction must leave no partial transaction row behind.
      await database().sql`create or replace function fail_trade_insert() returns trigger as $$ begin raise exception 'simulated crash'; end; $$ language plpgsql`;
      await database().sql`create trigger fail_trade before insert on wallet_trades for each row execute function fail_trade_insert()`;
      await expect(normalizeLiveEvent({ database: database() }, event?.id ?? "")).rejects.toThrow();
      expect(await counts()).toMatchObject({ tx: 0, trades: 0, flows: 0 });
      await database().sql`drop trigger fail_trade on wallet_trades`;
      expect((await normalizeLiveEvent({ database: database() }, event?.id ?? "")).outcome).toBe("PROCESSED");
      expect(await counts()).toMatchObject({ tx: 1, trades: 1 });
    });
  });

  describe("finality", () => {
    const provider = (status: FinalityStatus): FinalityProvider & { calls: number } => {
      const state = { calls: 0 };
      return { get calls() { return state.calls; }, getFinality: (signatures) => { state.calls += 1; return Promise.resolve(new Map(signatures.map((signature) => [signature, status]))); } };
    };
    const now = () => new Date();

    it("promotes a confirmed transaction to finalized when RPC reports it finalized", async () => {
      const walletId = await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      const metrics = newMetrics();
      const result = await checkSignatureFinality({ database: database(), provider: provider("FINALIZED"), metrics, now }, fixtures.pumpAmmBuy.signature);
      expect(result).toEqual({ status: "FINALIZED", walletIds: [walletId] });
      expect((await transactionRows())[0]).toMatchObject({ finality: "finalized" });
      expect((await transactionRows())[0]?.finalizedAt).not.toBeNull();
      expect(metrics.counter("finality_transitions_total", { to: "finalized" })).toBe(1);
    });

    it("keeps a transaction confirmed while RPC says confirmed, and records the check", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      expect((await checkSignatureFinality({ database: database(), provider: provider("CONFIRMED"), now }, fixtures.pumpAmmBuy.signature)).status).toBe("PENDING");
      const [tx] = await transactionRows();
      expect(tx?.finality).toBe("confirmed");
      expect(tx?.finalityCheckedAt).not.toBeNull();
    });

    it("waits for a young unknown signature, then drops it once it has been missing too long", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      expect((await checkSignatureFinality({ database: database(), provider: provider("NOT_FOUND"), now }, fixtures.pumpAmmBuy.signature)).status).toBe("PENDING");
      const later = () => new Date(Date.now() + FINALITY_DROP_AFTER_MS + 1_000);
      expect((await checkSignatureFinality({ database: database(), provider: provider("NOT_FOUND"), now: later }, fixtures.pumpAmmBuy.signature)).status).toBe("DROPPED");
      expect((await transactionRows())[0]?.finality).toBe("dropped");
    });

    it("drops a transaction the chain reports as failed", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      expect((await checkSignatureFinality({ database: database(), provider: provider("FAILED"), now }, fixtures.pumpAmmBuy.signature)).status).toBe("DROPPED");
    });

    it("does nothing (and makes no provider call) for finalized or unknown signatures", async () => {
      const walletId = await addWallet(database());
      await database().query.transaction((transaction) => persistHistoricalTransaction(transaction, walletId, normalizeHeliusTransaction(FIXTURE_WALLET as WalletAddress, fixtures.pumpAmmSell)));
      const spy = provider("FINALIZED");
      expect((await checkSignatureFinality({ database: database(), provider: spy, now }, fixtures.pumpAmmSell.signature)).status).toBe("NOTHING_TO_CHECK");
      expect((await checkSignatureFinality({ database: database(), provider: spy, now }, "unknown-signature")).status).toBe("NOTHING_TO_CHECK");
      expect(spy.calls).toBe(0);
    });

    it("propagates a provider timeout without changing state, so the job can retry", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy);
      const failing: FinalityProvider = { getFinality: () => Promise.reject(Object.assign(new Error("timeout"), { code: "TIMEOUT" })) };
      await expect(checkSignatureFinality({ database: database(), provider: failing, now }, fixtures.pumpAmmBuy.signature)).rejects.toThrow("timeout");
      expect((await transactionRows())[0]).toMatchObject({ finality: "confirmed", finalityCheckedAt: null });
    });

    it("finds confirmed transactions whose finality check was lost", async () => {
      await addWallet(database());
      await ingest(fixtures.pumpAmmBuy, fixtures.pumpAmmSell);
      await database().sql`update wallet_transactions set first_seen_at = now() - interval '10 minutes' where signature = ${fixtures.pumpAmmBuy.signature}`;
      expect(await findUncheckedConfirmed(database(), { now: new Date(), olderThanMs: 120_000, limit: 10 })).toEqual([fixtures.pumpAmmBuy.signature]);
    });
  });

  describe("gap backfill", () => {
    const history = (pages: HeliusTransaction[][]) => {
      const request = vi.fn<typeof fetch>((input) => {
        const before = new URL(input instanceof Request ? input.url : input.toString()).searchParams.get("before");
        const index = before === null ? 0 : pages.findIndex((page) => page.at(-1)?.signature === before) + 1;
        return Promise.resolve(new Response(JSON.stringify(pages[index] ?? []), { status: 200 }));
      });
      return { request, provider: new HeliusBlockchainProvider({ apiKey: "k", fetch: request }) };
    };

    it("recovers transactions a webhook never delivered and stops at what it already has", async () => {
      const walletId = await addWallet(database(), FIXTURE_WALLET, "ACTIVE", { historyCompleted: true });
      await ingest(fixtures.pumpAmmBuyNewAta);
      const { provider } = history([[fixtures.pumpAmmBuy, fixtures.pumpAmmSell, fixtures.pumpAmmBuyNewAta]]);
      const result = await backfillWalletGap({ database: database(), provider }, walletId);
      expect(result).toMatchObject({ status: "COMPLETED", transactionsCreated: 2 });
      expect(await counts()).toMatchObject({ tx: 3, trades: 3 });
      // The already-known confirmed transaction is finalized by history; new ones arrive finalized.
      expect((await transactionRows()).every((row) => row.finality === "finalized")).toBe(true);
      const [monitoring] = await database().query.select().from(schema.walletLiveMonitoring);
      expect(monitoring?.lastBackfillStatus).toBe("COMPLETED");
    });

    it("is idempotent when run again", async () => {
      const walletId = await addWallet(database(), FIXTURE_WALLET, "ACTIVE", { historyCompleted: true });
      const { provider } = history([[fixtures.pumpAmmBuy, fixtures.pumpAmmSell]]);
      await backfillWalletGap({ database: database(), provider }, walletId);
      const before = await counts();
      const again = await backfillWalletGap({ database: database(), provider }, walletId);
      expect(again.transactionsCreated).toBe(0);
      expect(await counts()).toEqual(before);
    });

    it("does not race an unfinished initial history run, and skips inactive wallets", async () => {
      const running = await addWallet(database(), FIXTURE_WALLET);
      const { provider, request } = history([[fixtures.pumpAmmBuy]]);
      expect((await backfillWalletGap({ database: database(), provider }, running)).status).toBe("SKIPPED_HISTORY_INCOMPLETE");
      const paused = await addWallet(database(), "PausedWallet1111111111111111111111111111111", "PAUSED", { historyCompleted: true });
      expect((await backfillWalletGap({ database: database(), provider }, paused)).status).toBe("SKIPPED_WALLET_INACTIVE");
      expect(request).not.toHaveBeenCalled();
    });

    it("propagates a provider timeout so the job retries, leaving no partial state", async () => {
      const walletId = await addWallet(database(), FIXTURE_WALLET, "ACTIVE", { historyCompleted: true });
      const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
      const provider = new HeliusBlockchainProvider({ apiKey: "k", fetch: request });
      await expect(backfillWalletGap({ database: database(), provider }, walletId)).rejects.toMatchObject({ code: "TIMEOUT" });
      expect((await counts()).tx).toBe(0);
    });
  });
});

describe("payload validation is shared", () => {
  it("fixtures parse with the same schema used at the endpoint", () => {
    expect(heliusTransaction.safeParse(fixtures.pumpAmmBuy).success).toBe(true);
  });
});
