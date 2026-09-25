/** Canonical mint of wrapped SOL. Native SOL and wSOL are normalized to this asset. */
export const WRAPPED_SOL_MINT = "So11111111111111111111111111111111111111112";
export const SOL_DECIMALS = 9;
export const LAMPORTS_PER_SOL = 1_000_000_000n;

export type QuoteAssetKind = "SOL" | "STABLECOIN";

export interface StablecoinDefinition {
  readonly symbol: string;
  readonly decimals: number;
}

/**
 * Explicit allow-list of canonical stablecoin mints (verified on-chain: SPL Token program, 6 decimals).
 * A token is never a stablecoin because of its symbol or name.
 */
export const canonicalStablecoins: ReadonlyMap<string, StablecoinDefinition> = new Map([
  ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { symbol: "USDC", decimals: 6 }],
  ["Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", { symbol: "USDT", decimals: 6 }],
]);

/** Decimals are checked as well, so a spoofed mint that happens to be mislabelled cannot pass. */
export function quoteAssetKind(mint: string, decimals: number): QuoteAssetKind | null {
  if (mint === WRAPPED_SOL_MINT) return decimals === SOL_DECIMALS ? "SOL" : null;
  const stablecoin = canonicalStablecoins.get(mint);
  return stablecoin?.decimals === decimals ? "STABLECOIN" : null;
}

/** Jito bundle tip payment accounts (mainnet). Transfers to them are execution cost, not swap consideration. */
export const jitoTipAccounts: ReadonlySet<string> = new Set([
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);

/** Aggregator venues as reported by the transaction provider. */
export const aggregatorVenues: ReadonlySet<string> = new Set(["JUPITER", "OKX_DEX_ROUTER", "DFLOW", "TITAN", "LIFINITY_ROUTER"]);
