import { describe, expect, it, vi } from "vitest";
import { defined } from "@swi/domain";
import { HeliusRpcClient } from "./helius-rpc";

const rpc = (request: typeof fetch) => new HeliusRpcClient({ apiKey: "k", fetch: request, sleep: () => Promise.resolve() });
const respond = (body: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe("HeliusRpcClient finality", () => {
  it("maps signature statuses onto finality states", async () => {
    const request = respond({ result: { value: [{ confirmationStatus: "finalized", err: null }, { confirmationStatus: "confirmed", err: null }, null, { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }, { confirmationStatus: "processed", err: null }] } });
    const result = await rpc(request).getFinality(["a", "b", "c", "d", "e"]);
    expect([...result]).toEqual([["a", "FINALIZED"], ["b", "CONFIRMED"], ["c", "NOT_FOUND"], ["d", "FAILED"], ["e", "CONFIRMED"]]);
    expect(JSON.parse(defined(request.mock.calls[0]?.[1]).body as string)).toMatchObject({ method: "getSignatureStatuses", params: [["a", "b", "c", "d", "e"], { searchTransactionHistory: true }] });
  });

  it("rejects a malformed or mismatched response instead of guessing", async () => {
    await expect(rpc(respond({ result: { value: [] } })).getFinality(["a"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(rpc(respond({ error: { code: -32602 } })).getFinality(["a"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("surfaces timeouts as retryable", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(rpc(request).getFinality(["a"])).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });
});

describe("HeliusRpcClient token launch", () => {
  it("reads the earliest transaction of a mint and its first signer", async () => {
    const request = respond({ result: { data: [{ slot: 448896046, blockTime: 1789951232, transaction: { signatures: ["sig1"], message: { accountKeys: [{ pubkey: "Signer111", signer: true }, { pubkey: "Mint111" }] } } }] } });
    expect(await rpc(request).getFirstActivity("Mint111")).toEqual({ status: "FOUND", firstActivityAt: new Date(1789951232 * 1000), firstActivitySlot: 448896046n, firstSignature: "sig1", firstSigner: "Signer111" });
  });

  it("reports unavailable instead of inventing launch facts", async () => {
    expect(await rpc(respond({ result: { data: [] } })).getFirstActivity("Mint111")).toEqual({ status: "UNAVAILABLE", reason: "NO_ACTIVITY_FOUND" });
    expect(await rpc(respond({ result: "nope" })).getFirstActivity("Mint111")).toEqual({ status: "UNAVAILABLE", reason: "INVALID_RESPONSE" });
  });
});
