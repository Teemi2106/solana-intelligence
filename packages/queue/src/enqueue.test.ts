import { describe, expect, it, vi } from "vitest";
import { enqueueFinalityCheck, enqueueNormalizeLiveEvents, enqueueReconcileSubscriptions, enqueueWalletRecompute, jobIds, normalizeJobOptions } from "./queues";

const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
const signature = "5".repeat(88);
const at = new Date("2026-09-25T12:00:04Z");

describe("deterministic job ids", () => {
  it("never contain a colon (BullMQ rejects it) and are stable for the same entity", () => {
    const ids = [jobIds.normalizeLiveEvent(id), jobIds.walletRecompute(id, "full", at), jobIds.finalityCheck(signature, 2), jobIds.gapBackfill(id, at), jobIds.reconcile(at), jobIds.tokenLaunch(id, at)];
    for (const value of ids) expect(value).not.toContain(":");
    expect(jobIds.normalizeLiveEvent(id)).toBe(jobIds.normalizeLiveEvent(id));
    expect(jobIds.finalityCheck(signature, 2)).toBe(jobIds.finalityCheck(signature, 2));
  });

  it("dedupes bursts inside a time bucket but allows work again in the next bucket", () => {
    expect(jobIds.walletRecompute(id, "full", at)).toBe(jobIds.walletRecompute(id, "full", new Date(at.getTime() + 3_000)));
    expect(jobIds.walletRecompute(id, "full", at)).not.toBe(jobIds.walletRecompute(id, "full", new Date(at.getTime() + 20_000)));
  });

  it("keeps price-only and full recomputes, and different attempts, distinct", () => {
    expect(jobIds.walletRecompute(id, "full", at)).not.toBe(jobIds.walletRecompute(id, "price-only", at));
    expect(jobIds.finalityCheck(signature, 1)).not.toBe(jobIds.finalityCheck(signature, 2));
  });
});

describe("enqueue helpers", () => {
  it("enqueues one normalize job per persisted event with the retry policy and a deterministic id", async () => {
    const addBulk = vi.fn().mockResolvedValue([]);
    await enqueueNormalizeLiveEvents({ transactionIngestion: { addBulk } as never }, [id]);
    expect(addBulk).toHaveBeenCalledWith([{ name: "normalize-live-event", data: { providerEventId: id }, opts: { ...normalizeJobOptions, jobId: `live-normalize-${id}` } }]);
    expect(normalizeJobOptions).toMatchObject({ attempts: 8, backoff: { type: "exponential" } });
  });

  it("does nothing for an empty batch", async () => {
    const addBulk = vi.fn();
    await enqueueNormalizeLiveEvents({ transactionIngestion: { addBulk } as never }, []);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it("delays finality checks and bounds their retries", async () => {
    const add = vi.fn().mockResolvedValue({});
    await enqueueFinalityCheck({ liveMaintenance: { add } as never }, signature, 3, 30_000);
    expect(add).toHaveBeenCalledWith("finality-check", { signature, attempt: 3 }, expect.objectContaining({ jobId: jobIds.finalityCheck(signature, 3), delay: 30_000, attempts: 3 }));
  });

  it("recompute and reconcile jobs carry deterministic ids", async () => {
    const add = vi.fn().mockResolvedValue({});
    await enqueueWalletRecompute({ analysis: { add } as never }, id, "full", at, 500);
    await enqueueReconcileSubscriptions({ liveMaintenance: { add } as never }, "wallet-created", at);
    expect(add).toHaveBeenNthCalledWith(1, "wallet-recompute", { walletId: id, mode: "full" }, { jobId: jobIds.walletRecompute(id, "full", at), delay: 500 });
    expect(add).toHaveBeenNthCalledWith(2, "reconcile-subscriptions", { reason: "wallet-created" }, expect.objectContaining({ jobId: jobIds.reconcile(at), attempts: 8 }));
  });
});
