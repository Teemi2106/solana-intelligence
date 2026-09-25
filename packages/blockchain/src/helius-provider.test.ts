import { describe, expect, it, vi } from "vitest";
import type { WalletAddress } from "@swi/domain";
import { HeliusBlockchainProvider } from "./helius-provider";
import type { ProviderRequestError } from "./errors";

const address = "11111111111111111111111111111111" as WalletAddress;
const signature = "5".repeat(88);
const transaction = { signature, slot: 10, timestamp: 1_700_000_000, type: "SWAP", fee: 5000, transactionError: null, tokenTransfers: [], nativeTransfers: [] };

describe("HeliusBlockchainProvider", () => {
  it("paginates with the last signature", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([transaction]), { status: 200 }));
    const provider = new HeliusBlockchainProvider({ apiKey: "secret", fetch: request });
    const page = await provider.getWalletHistory(address, { limit: 1 });
    expect(page.nextCursor).toBe(signature);
    expect(page.transactions[0]?.slot).toBe(10n);
  });

  it("uses precise wallet-owned ATA balance changes from routed swaps", async () => {
    const routedSwap = {
      ...transaction,
      tokenTransfers: [{
        mint: "So11111111111111111111111111111111111111112",
        tokenAmount: 1.25,
        fromUserAccount: address,
        toUserAccount: "22222222222222222222222222222222",
      }],
      accountData: [
        { account: address, nativeBalanceChange: -1_250_005_000, tokenBalanceChanges: [] },
        { account: "33333333333333333333333333333333", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: address, tokenAccount: "44444444444444444444444444444444", mint: "TokenMint111111111111111111111111111111111", rawTokenAmount: { tokenAmount: "987654321012345", decimals: 6 } }] },
      ],
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([routedSwap]), { status: 200 }));
    const page = await new HeliusBlockchainProvider({ apiKey: "secret", fetch: request }).getWalletHistory(address);
    expect(page.transactions[0]).toMatchObject({
      nativeSolDeltaLamports: -1_250_005_000n,
      tokenFlows: [{ direction: "IN", rawAmount: 987654321012345n, decimals: 6 }],
      issues: [],
    });
  });

  it("retries a rate limit and honors retry-after", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("", { status: 429, headers: { "retry-after": "0" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), { status: 200 }));
    await new HeliusBlockchainProvider({ apiKey: "secret", fetch: request }).getWalletHistory(address);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("surfaces timeouts as retryable provider errors", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    await expect(new HeliusBlockchainProvider({ apiKey: "secret", fetch: request }).getWalletHistory(address)).rejects.toMatchObject<Partial<ProviderRequestError>>({ code: "TIMEOUT", retryable: true });
  });

  it("separates ATA rent, third-party rent, the wSOL counterparty ledger and tips from a PumpSwap-style buy", async () => {
    const wsol = "So11111111111111111111111111111111111111112";
    const tip = "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5";
    const change = (userAccount: string, mint: string, tokenAmount: string, decimals: number) => ({ userAccount, tokenAccount: "9".repeat(44), mint, rawTokenAmount: { tokenAmount, decimals } });
    const buy = {
      ...transaction, source: "PUMP_AMM", fee: 5_300, feePayer: address,
      nativeTransfers: [{ fromUserAccount: address, toUserAccount: tip, amount: 100_000 }],
      accountData: [
        { account: address, nativeBalanceChange: -11_004_023_780, tokenBalanceChanges: [] },
        // New wallet-owned ATA: rent locked, not consideration.
        { account: "AtaOwnedByWallet1111111111111111111111111111", nativeBalanceChange: 2_074_080, tokenBalanceChanges: [change(address, "TokenMint111111111111111111111111111111111", "6380253405420", 6)] },
        // Pool and fee vault wSOL accounts: their gain is exactly what the wallet paid.
        { account: "PoolVault11111111111111111111111111111111111", nativeBalanceChange: 10_896_688_086, tokenBalanceChanges: [change("PoolAuth", wsol, "10896688086", 9)] },
        { account: "FeeVault111111111111111111111111111111111111", nativeBalanceChange: 103_311_914, tokenBalanceChanges: [change("FeeAuth", wsol, "103311914", 9)] },
        // Rent the wallet funded for an account it does not own.
        { account: "ThirdParty11111111111111111111111111111111111", nativeBalanceChange: 1_844_400, tokenBalanceChanges: [] },
      ],
      tokenTransfers: [{ mint: "Intermediate1111111111111111111111111111111", fromUserAccount: "x", toUserAccount: "y" }],
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([buy]), { status: 200 }));
    const [normalized] = (await new HeliusBlockchainProvider({ apiKey: "secret", fetch: request }).getWalletHistory(address)).transactions;
    expect(normalized?.settlement).toEqual({
      venue: "PUMP_AMM",
      walletTokenAccountRentLamports: 2_074_080n,
      counterpartyWsolDeltaLamports: 11_000_000_000n,
      tipLamports: 100_000n,
      movedMints: ["Intermediate1111111111111111111111111111111", "TokenMint111111111111111111111111111111111", wsol].sort(),
    });
    expect(normalized?.tokenFlows).toHaveLength(1);
  });

  it("subtracts wSOL principal from a wallet-owned wSOL account so only its rent is counted", async () => {
    const wsol = "So11111111111111111111111111111111111111112";
    const swap = {
      ...transaction,
      accountData: [{ account: "WalletWsolAccount111111111111111111111111111", nativeBalanceChange: 1_002_039_280, tokenBalanceChanges: [{ userAccount: address, tokenAccount: "9".repeat(44), mint: wsol, rawTokenAmount: { tokenAmount: "1000000000", decimals: 9 } }] }],
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify([swap]), { status: 200 }));
    const [normalized] = (await new HeliusBlockchainProvider({ apiKey: "secret", fetch: request }).getWalletHistory(address)).transactions;
    expect(normalized?.settlement.walletTokenAccountRentLamports).toBe(2_039_280n);
    expect(normalized?.settlement.counterpartyWsolDeltaLamports).toBeNull();
  });
});
