import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { schema } from "@swi/db";
import { createTestDatabase, requireDatabase } from "@swi/db/testing";
import { defined, type LiveSubscriptionProvider, type LiveSubscriptionState } from "@swi/domain";
import { countMonitoredWallets, reconcileSubscriptions } from "./subscriptions";
import { addWallet, newMetrics, resetDatabase } from "./test-helpers";

const context = await createTestDatabase();
afterAll(async () => context?.dispose());

/** In-memory provider with the same read/write/read-back shape as the real one, plus failure injection. */
class FakeProvider implements LiveSubscriptionProvider {
  readonly maxAddresses = 100_000;
  state: LiveSubscriptionState | null = null;
  readonly writes: string[] = [];
  failNext: { method: string; error: Error } | null = null;
  /** When set, the read-back after a write reports this address set (a provider that silently ignored the update). */
  ignoreWrites = false;

  private maybeFail(method: string): void {
    if (this.failNext?.method === method) {
      const { error } = this.failNext;
      this.failNext = null;
      throw error;
    }
  }
  findSubscription(): Promise<LiveSubscriptionState | null> {
    this.maybeFail("find");
    return Promise.resolve(this.state);
  }
  createSubscription(addresses: readonly string[]): Promise<LiveSubscriptionState> {
    this.maybeFail("create");
    this.writes.push("create");
    this.state = { externalId: "wh_1", webhookUrl: "https://example.com/hook", addresses: this.ignoreWrites ? [] : [...addresses].sort(), active: true };
    return Promise.resolve(this.state);
  }
  replaceAddresses(_id: string, addresses: readonly string[]): Promise<LiveSubscriptionState> {
    this.maybeFail("replace");
    this.writes.push("replace");
    if (this.state && !this.ignoreWrites) this.state = { ...this.state, addresses: [...addresses].sort() };
    return Promise.resolve(defined(this.state));
  }
  setActive(_id: string, active: boolean): Promise<LiveSubscriptionState> {
    this.maybeFail("setActive");
    this.writes.push(active ? "activate" : "deactivate");
    this.state = { ...defined(this.state), active };
    return Promise.resolve(this.state);
  }
  checkHealth() {
    return Promise.resolve({ name: "fake", status: "up" as const, latencyMs: 1 });
  }
}

describe.skipIf(!context)("subscription reconciliation", () => {
  const database = () => requireDatabase(context);
  let provider: FakeProvider;
  const current = () => provider.state;
  beforeEach(async () => {
    await resetDatabase(database());
    provider = new FakeProvider();
  });
  const reconcile = (overrides: { enabled?: boolean } = {}) => reconcileSubscriptions({ database: database(), provider, enabled: overrides.enabled ?? true, metrics: newMetrics() });
  const runs = () => database().query.select().from(schema.providerSyncRuns);
  const A = "WalletA11111111111111111111111111111111111111";
  const B = "WalletB11111111111111111111111111111111111111";
  const C = "WalletC11111111111111111111111111111111111111";

  it("creates the subscription for active wallets and confirms monitoring", async () => {
    const a = await addWallet(database(), A);
    await addWallet(database(), B);
    const result = await reconcile();
    expect(result).toMatchObject({ outcome: "CREATED", desired: 2, newlyMonitoredWalletIds: expect.arrayContaining([a]) as string[] });
    expect(current()?.addresses).toEqual([A, B]);
    expect(await countMonitoredWallets(database())).toBe(2);
    expect((await runs())[0]).toMatchObject({ outcome: "CREATED", desiredCount: 2, providerCount: 2, errorCode: null });
    expect((await database().query.select().from(schema.providerSubscriptions))[0]).toMatchObject({ status: "IN_SYNC", externalId: "wh_1" });
  });

  it("adding a tracked wallet eventually adds it to the provider, and only the new wallet needs a gap backfill", async () => {
    await addWallet(database(), A);
    await reconcile();
    const c = await addWallet(database(), C);
    const result = await reconcile();
    expect(result).toMatchObject({ outcome: "UPDATED", added: [C], removed: [], newlyMonitoredWalletIds: [c] });
    expect(current()?.addresses).toEqual([A, C]);
  });

  it("pausing or archiving a wallet removes it from the provider", async () => {
    await addWallet(database(), A);
    const b = await addWallet(database(), B);
    await reconcile();
    await database().sql`update tracked_wallets set status = 'PAUSED' where id = ${b}`;
    const result = await reconcile();
    expect(result).toMatchObject({ outcome: "UPDATED", added: [], removed: [B] });
    expect(current()?.addresses).toEqual([A]);
    expect(await countMonitoredWallets(database())).toBe(1);
    const [row] = await database().query.select().from(schema.walletLiveMonitoring).where((await import("drizzle-orm")).eq(schema.walletLiveMonitoring.walletId, b));
    expect(row?.providerConfirmedAt).toBeNull();
  });

  it("is idempotent: an in-sync subscription causes no provider writes (management calls cost credits)", async () => {
    await addWallet(database(), A);
    await reconcile();
    provider.writes.length = 0;
    expect((await reconcile()).outcome).toBe("NO_CHANGE");
    expect(provider.writes).toEqual([]);
  });

  it("repairs drift: extra addresses at the provider are removed, missing ones added", async () => {
    await addWallet(database(), A);
    await addWallet(database(), B);
    provider.state = { externalId: "wh_1", webhookUrl: "https://example.com/hook", addresses: [A, "StaleWallet111111111111111111111111111111111"], active: true };
    const result = await reconcile();
    expect(result).toMatchObject({ outcome: "UPDATED", added: [B], removed: ["StaleWallet111111111111111111111111111111111"] });
    expect(current()?.addresses).toEqual([A, B]);
  });

  it("re-enables a webhook the provider disabled", async () => {
    await addWallet(database(), A);
    provider.state = { externalId: "wh_1", webhookUrl: "https://example.com/hook", addresses: [A], active: false };
    expect((await reconcile()).outcome).toBe("REACTIVATED");
    expect(current()?.active).toBe(true);
    expect(provider.writes).toEqual(["activate"]);
  });

  it("pauses deliveries instead of writing an empty address list when no wallet is active", async () => {
    const a = await addWallet(database(), A);
    await reconcile();
    await database().sql`update tracked_wallets set status = 'ARCHIVED' where id = ${a}`;
    expect((await reconcile()).outcome).toBe("DEACTIVATED");
    expect(current()?.active).toBe(false);
    expect(await countMonitoredWallets(database())).toBe(0);
  });

  it("does nothing when there is nothing desired and nothing at the provider", async () => {
    expect((await reconcile()).outcome).toBe("SKIPPED_NO_WALLETS");
    expect(provider.writes).toEqual([]);
  });

  it("does not touch the provider at all when live ingestion is disabled", async () => {
    await addWallet(database(), A);
    const result = await reconcile({ enabled: false });
    expect(result.outcome).toBe("SKIPPED_DISABLED");
    expect(provider.state).toBeNull();
    expect(provider.writes).toEqual([]);
    expect(await runs()).toEqual([]);
  });

  it("records a partial failure, marks the subscription errored and rethrows so the job retries", async () => {
    await addWallet(database(), A);
    await reconcile();
    await addWallet(database(), B);
    provider.failNext = { method: "replace", error: Object.assign(new Error("boom"), { code: "TIMEOUT" }) };
    await expect(reconcile()).rejects.toThrow("boom");
    const failed = (await runs()).find((run) => run.outcome === "FAILED");
    expect(failed).toMatchObject({ errorCode: "TIMEOUT" });
    expect((await database().query.select().from(schema.providerSubscriptions))[0]).toMatchObject({ status: "ERROR", lastErrorCode: "TIMEOUT" });
    // The next attempt converges without manual repair.
    expect((await reconcile()).outcome).toBe("UPDATED");
    expect(current()?.addresses).toEqual([A, B]);
    expect((await database().query.select().from(schema.providerSubscriptions))[0]).toMatchObject({ status: "IN_SYNC", lastErrorCode: null });
  });

  it("refuses to trust a write the provider did not apply (read-back verification)", async () => {
    await addWallet(database(), A);
    await reconcile();
    await addWallet(database(), B);
    provider.ignoreWrites = true;
    await expect(reconcile()).rejects.toMatchObject({ code: "SYNC_VERIFICATION_FAILED" });
    expect(await countMonitoredWallets(database())).toBe(1);
    expect((await runs()).at(-1)).toMatchObject({ outcome: "FAILED", errorCode: "SYNC_VERIFICATION_FAILED" });
  });

  it("keeps desired state in the database across worker restarts: a fresh reconcile rebuilds a lost provider subscription", async () => {
    await addWallet(database(), A);
    await reconcile();
    provider.state = null;
    expect((await reconcile()).outcome).toBe("CREATED");
    expect(current()?.addresses).toEqual([A]);
  });
});
