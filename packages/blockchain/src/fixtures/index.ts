import { readFileSync } from "node:fs";
import { z } from "zod";
import { heliusTransaction, type HeliusTransaction } from "../helius-schemas";

/** Public wallet the fixtures were captured from (real enhanced-transaction payloads, instruction bodies stripped). */
export const FIXTURE_WALLET = "GatgyE2SqnNNjNeNGR8MG1VSVxFGxgyjB111hYJRTkee";

const schema = z.object({
  pumpAmmSell: heliusTransaction,
  pumpAmmBuy: heliusTransaction,
  pumpAmmBuyNewAta: heliusTransaction,
  pumpAmmSellSmall: heliusTransaction,
  pumpFunNativeBuy: heliusTransaction,
  meteoraSwap: heliusTransaction,
  systemTransfer: heliusTransaction,
  tokenTransfer: heliusTransaction,
  replaySet: z.array(heliusTransaction),
});

export type WalletFixtures = z.infer<typeof schema>;

export function loadWalletFixtures(): WalletFixtures {
  return schema.parse(JSON.parse(readFileSync(new URL("./helius-wallet-fixtures.json", import.meta.url), "utf8")));
}

/** Structurally faithful Jupiter-routed buy (SOL -> USDC -> BONK-like -> TOKEN), derived from a real PumpSwap buy. Synthetic: the fixture wallet never used Jupiter. */
export function jupiterRoutedBuy(base: HeliusTransaction): HeliusTransaction {
  return {
    ...base,
    signature: "J".repeat(88),
    source: "JUPITER",
    tokenTransfers: [
      ...base.tokenTransfers,
      { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", fromUserAccount: "JupiterRouteAuthority1111111111111111111111", toUserAccount: "PoolAuthorityUsdc111111111111111111111111111", rawTokenAmount: { tokenAmount: "117000000", decimals: 6 } },
    ],
    accountData: [
      ...base.accountData,
      { account: "RouteUsdcVaultIn111111111111111111111111111111", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: "PoolAuthorityUsdc111111111111111111111111111", tokenAccount: "RouteUsdcVaultIn111111111111111111111111111111", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "117000000", decimals: 6 } }] },
      { account: "RouteUsdcVaultOut11111111111111111111111111111", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: "JupiterRouteAuthority1111111111111111111111", tokenAccount: "RouteUsdcVaultOut11111111111111111111111111111", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", rawTokenAmount: { tokenAmount: "-117000000", decimals: 6 } }] },
    ],
  };
}
