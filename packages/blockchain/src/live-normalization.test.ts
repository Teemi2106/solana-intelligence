import { describe, expect, it, vi } from "vitest";
import { defined, reconstructSwap, WRAPPED_SOL_MINT, type WalletAddress } from "@swi/domain";
import { FIXTURE_WALLET, jupiterRoutedBuy, loadWalletFixtures } from "./fixtures/index";
import { HeliusBlockchainProvider, involvedAddresses, normalizeHeliusTransaction } from "./helius-provider";
import { heliusWebhookPayload } from "./helius-webhook";

const wallet = FIXTURE_WALLET as WalletAddress;
const fixtures = loadWalletFixtures();
const normalize = (transaction: Parameters<typeof normalizeHeliusTransaction>[1]) => reconstructSwap(normalizeHeliusTransaction(wallet, transaction));
const only = (transaction: Parameters<typeof normalizeHeliusTransaction>[1]) => {
  const result = normalize(transaction);
  expect(result.legs).toHaveLength(1);
  return defined(result.legs[0]);
};

describe("live transaction normalization on real fixtures", () => {
  it("live SOL -> token: PumpSwap buy uses the exact wSOL ledger and excludes fees", () => {
    const leg = only(fixtures.pumpAmmBuy);
    expect(leg).toMatchObject({ side: "BUY", quoteKind: "SOL", consideration: "EXACT", wsolNormalized: true, routed: false, venue: "PUMP_AMM" });
    expect(leg.quote).toEqual({ mint: WRAPPED_SOL_MINT, rawAmount: 3_300_000_000n, decimals: 9 });
    expect(leg.feeLamports).toBe(65_000n);
  });

  it("live token -> SOL: PumpSwap sell derives proceeds through a temporary wSOL account", () => {
    const leg = only(fixtures.pumpAmmSell);
    expect(leg).toMatchObject({ side: "SELL", quoteKind: "SOL", consideration: "EXACT" });
    expect(leg.quote?.rawAmount).toBe(192_852_999_409n);
  });

  it("separates ATA creation and third-party account rent from consideration", () => {
    const leg = only(fixtures.pumpAmmBuyNewAta);
    expect(leg.quote?.rawAmount).toBe(11_000_000_000n);
    expect(leg.rentExcludedLamports).toBe(2_074_080n);
    expect(leg.unattributedLamports).toBe(-1_844_400n);
    expect(leg.networkFeeLamports).toBe(5_300n);
  });

  it("handles a native pump.fun bonding-curve buy as a derived SOL consideration", () => {
    const leg = only(fixtures.pumpFunNativeBuy);
    expect(leg).toMatchObject({ side: "BUY", quoteKind: "SOL", consideration: "DERIVED", wsolNormalized: false });
  });

  it("handles a Meteora swap without failing", () => {
    expect(["SWAP", "AMBIGUOUS"]).toContain(normalize(fixtures.meteoraSwap).kind);
  });

  it("classifies plain transfers as transfers or other, never as trades", () => {
    expect(normalize(fixtures.systemTransfer).legs).toEqual([]);
    const tokenTransfer = normalize(fixtures.tokenTransfer);
    expect(tokenTransfer.kind).toBe("TRANSFER");
    expect(tokenTransfer.legs).toEqual([]);
  });

  it("records a failed transaction without any trade", () => {
    const failed = { ...fixtures.pumpAmmBuy, transactionError: { InstructionError: [2, { Custom: 6001 }] } };
    const normalized = normalizeHeliusTransaction(wallet, failed);
    expect(normalized.succeeded).toBe(false);
    expect(reconstructSwap(normalized)).toMatchObject({ kind: "OTHER", legs: [], issues: ["FAILED_TRANSACTION"] });
  });

  it("treats a Jupiter routed swap as SOL -> TOKEN and lists intermediate assets without trading them", () => {
    const leg = only(jupiterRoutedBuy(fixtures.pumpAmmBuy));
    expect(leg).toMatchObject({ side: "BUY", routed: true, quoteKind: "SOL", venue: "JUPITER" });
    expect(leg.routeAssets).toContain("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(leg.quote?.rawAmount).toBe(3_300_000_000n);
  });

  it("degrades an unsupported structure safely instead of guessing", () => {
    // Two different tokens both received by the wallet in one "swap": no single consideration can be established.
    const first = fixtures.pumpAmmBuy.accountData.find((account) => account.tokenBalanceChanges.some((change) => change.userAccount === wallet));
    const extra = { account: "ExtraTokenAccount1111111111111111111111111111", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: wallet, tokenAccount: "ExtraTokenAccount1111111111111111111111111111", mint: "OtherMint11111111111111111111111111111111111", rawTokenAmount: { tokenAmount: "5", decimals: 6 } }] };
    expect(first).toBeDefined();
    const result = normalize({ ...fixtures.pumpAmmBuy, accountData: [...fixtures.pumpAmmBuy.accountData, extra] });
    expect(result.kind).toBe("AMBIGUOUS");
    expect(result.legs).toEqual([]);
  });

  it("finds the tracked wallet among the involved addresses, including counterparties", () => {
    const addresses = involvedAddresses(fixtures.pumpAmmBuy);
    expect(addresses.has(FIXTURE_WALLET)).toBe(true);
    expect(addresses.size).toBeGreaterThan(3);
  });

  it("captures the counterparty of a token transfer receipt", () => {
    const normalized = normalizeHeliusTransaction(wallet, fixtures.tokenTransfer);
    expect(normalized.tokenFlows.length).toBeGreaterThan(0);
  });
});

describe("historical and live normalization converge", () => {
  it("produces identical normalized transactions and economic legs through both paths", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([fixtures.pumpAmmBuy, fixtures.pumpAmmSell, fixtures.pumpAmmBuyNewAta, fixtures.pumpFunNativeBuy]), { status: 200 }));
    const history = (await new HeliusBlockchainProvider({ apiKey: "k", fetch: request }).getWalletHistory(wallet, { limit: 100 })).transactions;
    // The webhook path: validate the delivery, then normalize each item for the tracked wallet.
    const delivered = heliusWebhookPayload.parse(JSON.parse(JSON.stringify([fixtures.pumpAmmBuy, fixtures.pumpAmmSell, fixtures.pumpAmmBuyNewAta, fixtures.pumpFunNativeBuy])));
    const live = delivered.map((transaction) => normalizeHeliusTransaction(wallet, transaction));
    const canonical = (transactions: typeof live) => JSON.stringify(transactions.map((transaction) => ({ ...transaction, source: undefined, legs: reconstructSwap(transaction).legs })), (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
    expect(canonical(live)).toBe(canonical([...history]));
  });
});
