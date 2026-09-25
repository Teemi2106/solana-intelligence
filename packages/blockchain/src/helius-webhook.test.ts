import { describe, expect, it } from "vitest";
import { loadWalletFixtures } from "./fixtures/index";
import { heliusAuthHeaderValue, heliusLiveEventId, heliusWebhookPayload, MAX_WEBHOOK_TRANSACTIONS, payloadHash, verifyHeliusAuthorization } from "./helius-webhook";

const secret = "s".repeat(40);
const fixtures = loadWalletFixtures();

describe("webhook authentication", () => {
  it("accepts exactly the configured authorization header", () => {
    expect(verifyHeliusAuthorization(heliusAuthHeaderValue(secret), secret)).toBe(true);
  });

  it.each([
    ["missing header", null],
    ["empty header", ""],
    ["bare secret without the configured scheme", secret],
    ["wrong secret", heliusAuthHeaderValue("x".repeat(40))],
    ["secret with a suffix", `${heliusAuthHeaderValue(secret)}x`],
    ["different case scheme", `bearer ${secret}`],
  ])("rejects %s", (_name, header) => {
    expect(verifyHeliusAuthorization(header, secret)).toBe(false);
  });
});

describe("webhook payload schema", () => {
  it("accepts real enhanced transactions", () => {
    expect(heliusWebhookPayload.safeParse([fixtures.pumpAmmBuy, fixtures.pumpAmmSell]).success).toBe(true);
  });

  it.each([
    ["an object instead of an array", { signature: "x" }],
    ["an empty array", []],
    ["a string", "hello"],
    ["null", null],
    ["a transaction without a signature", [{ ...fixtures.pumpAmmBuy, signature: undefined }]],
    ["a non-integer slot", [{ ...fixtures.pumpAmmBuy, slot: 1.5 }]],
    ["a negative fee", [{ ...fixtures.pumpAmmBuy, fee: -1 }]],
    ["a malformed raw token amount", [{ ...fixtures.pumpAmmBuy, accountData: [{ account: "a", nativeBalanceChange: 0, tokenBalanceChanges: [{ tokenAccount: "t", mint: "M".repeat(44), rawTokenAmount: { tokenAmount: "12.5", decimals: 6 } }] }] }]],
    ["token decimals out of range", [{ ...fixtures.pumpAmmBuy, accountData: [{ account: "a", nativeBalanceChange: 0, tokenBalanceChanges: [{ tokenAccount: "t", mint: "M".repeat(44), rawTokenAmount: { tokenAmount: "1", decimals: 99 } }] }] }]],
  ])("rejects %s", (_name, body) => {
    expect(heliusWebhookPayload.safeParse(body).success).toBe(false);
  });

  it("bounds the number of transactions per delivery", () => {
    const many = Array.from({ length: MAX_WEBHOOK_TRANSACTIONS + 1 }, () => fixtures.pumpAmmBuy);
    expect(heliusWebhookPayload.safeParse(many).success).toBe(false);
    expect(heliusWebhookPayload.safeParse(many.slice(0, MAX_WEBHOOK_TRANSACTIONS)).success).toBe(true);
  });

  it("drops fields it does not model instead of storing them", () => {
    const parsed = heliusWebhookPayload.parse([{ ...fixtures.pumpAmmBuy, surprise: "x".repeat(1000) }]);
    expect(parsed[0]).not.toHaveProperty("surprise");
  });
});

describe("event identity", () => {
  it("is deterministic per signature and independent of delivery content", () => {
    expect(heliusLiveEventId(fixtures.pumpAmmBuy.signature)).toBe(heliusLiveEventId(fixtures.pumpAmmBuy.signature));
    expect(heliusLiveEventId(fixtures.pumpAmmBuy.signature)).not.toBe(heliusLiveEventId(fixtures.pumpAmmSell.signature));
    expect(heliusLiveEventId("abc")).toBe("helius:live:abc");
  });

  it("hashes payloads deterministically", () => {
    expect(payloadHash(fixtures.pumpAmmBuy)).toBe(payloadHash(structuredClone(fixtures.pumpAmmBuy)));
    expect(payloadHash(fixtures.pumpAmmBuy)).not.toBe(payloadHash(fixtures.pumpAmmSell));
  });
});
