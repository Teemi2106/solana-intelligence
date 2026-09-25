import { afterAll, describe, expect, it } from "vitest";
import { getLiveSystemStatus, getWalletActivity } from "./live-repository";
import { providerEvents, providerSubscriptions, providerSyncRuns, systemHealth, trackedWallets, walletTransactions } from "./schema/index";
import { createTestDatabase, requireDatabase } from "./testing";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());

describe.skipIf(!context)("live status queries", () => {
  const database = () => requireDatabase(context);

  it("reports an empty system without failing", async () => {
    const status = await getLiveSystemStatus(database());
    expect(status).toMatchObject({ activeWallets: 0, monitoredWallets: 0, lastWebhookReceivedAt: null, unresolvedFailures: 0, subscription: null, lastSyncRun: null, worker: null });
    expect(status.latencyMs).toEqual({ averageMs: null, p95Ms: null, samples: 0 });
  });

  it("returns real Date objects and correct counts for populated state", async () => {
    const now = new Date();
    const [wallet] = await database().query.insert(trackedWallets).values({ address: "StatusWallet11111111111111111111111111111111", status: "ACTIVE" }).returning();
    await database().query.insert(providerEvents).values([
      { provider: "helius", externalEventId: "helius:live:a", payloadHash: "h", eventType: "LIVE_TRANSACTION", status: "PROCESSED", payloadSummary: {}, receivedAt: new Date(now.getTime() - 3_000), processedAt: new Date(now.getTime() - 2_000) },
      { provider: "helius", externalEventId: "helius:live:b", payloadHash: "h", eventType: "LIVE_TRANSACTION", status: "RECEIVED", payloadSummary: {}, receivedAt: new Date(now.getTime() - 1_000) },
    ]);
    await database().query.insert(providerSubscriptions).values({ provider: "helius", kind: "wallet-activity-webhook", externalId: "wh_abcdef123456", status: "IN_SYNC", desiredAddressCount: 1, providerAddressCount: 1, lastSyncedAt: now });
    await database().query.insert(providerSyncRuns).values({ provider: "helius", startedAt: now, finishedAt: now, outcome: "UPDATED", added: 1 });
    await database().query.insert(systemHealth).values({ component: "worker", instanceId: "1", status: "up", details: { liveEnabled: true }, heartbeatAt: now });
    const status = await getLiveSystemStatus(database(), now);
    expect(status.lastWebhookReceivedAt).toBeInstanceOf(Date);
    expect(status.lastWebhookReceivedAt?.getTime()).toBe(now.getTime() - 1_000);
    expect(status).toMatchObject({ activeWallets: 1, eventsLastHour: { PROCESSED: 1, RECEIVED: 1 } });
    expect(status.latencyMs.samples).toBe(1);
    expect(status.latencyMs.p95Ms).toBeCloseTo(1_000, -2);
    expect(status.subscription).toMatchObject({ status: "IN_SYNC", externalIdSuffix: "123456" });
    expect(status.subscription?.lastSyncedAt).toBeInstanceOf(Date);
    expect(status.lastSyncRun).toMatchObject({ outcome: "UPDATED", added: 1 });
    expect(status.worker).toMatchObject({ status: "up", liveEnabled: true });
    expect(wallet?.id).toBeDefined();
  });

  it("lists wallet activity newest first with finality and processing state", async () => {
    const [wallet] = await database().query.select().from(trackedWallets);
    const [event] = await database().query.select().from(providerEvents).limit(1);
    await database().query.insert(walletTransactions).values([
      { walletId: wallet?.id ?? "", providerEventId: event?.id ?? "", signature: "sigOld", instructionIndex: 0, kind: "TRANSFER", slot: 1n, occurredAt: new Date("2026-09-01T00:00:00Z"), finality: "finalized", succeeded: true, normalizedPayload: {} },
      { walletId: wallet?.id ?? "", providerEventId: event?.id ?? "", signature: "sigNew", instructionIndex: 0, kind: "SWAP", slot: 2n, occurredAt: new Date("2026-09-02T00:00:00Z"), finality: "confirmed", ingestionSource: "helius-webhook", succeeded: true, normalizedPayload: {} },
    ]);
    const activity = await getWalletActivity(database(), wallet?.id ?? "");
    expect(activity.map((row) => [row.signature, row.finality, row.ingestionSource, row.processingState])).toEqual([["sigNew", "confirmed", "helius-webhook", "PROCESSED"], ["sigOld", "finalized", "helius-history", "PROCESSED"]]);
  });
});
