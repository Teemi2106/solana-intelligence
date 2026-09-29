import type { CanonicalEconomicEvidence } from "@swi/domain";
import type { HeliusTransaction } from "../helius-schemas";

const FIXTURE_WALLET = "GatgyE2SqnNNjNeNGR8MG1VSVxFGxgyjB111hYJRTkee";

export const GTA6_MINT = "CHyPGNd9d7enSG9MiFfbLaYN7PcP8Z7V4Jp2RH73pump";
export const GTA6_RAW_POSITION = 25_659_509_885_469n;

/** Sanitized from production: only deterministic wallet-economic fields are retained. */
export const fullExitFixture: HeliusTransaction = {
  signature: "4bprMUEiN1vaZpNXxExeQRGSzLY98CtDUaM4thChKMSx1qtiSPumwv3WSpirtMe1PuAtCp8KQD2D71A2kNjX5vr2",
  slot: 451315070, timestamp: 1790597426, type: "SWAP", source: "PUMP_AMM", fee: 65_000, feePayer: FIXTURE_WALLET, transactionError: null,
  tokenTransfers: [],
  nativeTransfers: [{ fromUserAccount: "A9F9VoR7sf8tUAeqXDCZjXJ4NhyvHC3DeRB9buMQgGfZ", toUserAccount: FIXTURE_WALLET, amount: 399_123_558_197 }],
  accountData: [
    { account: FIXTURE_WALLET, nativeBalanceChange: 399_123_493_197, tokenBalanceChanges: [] },
    { account: "9Di2MQ5CqmJ2DQee2MTb5TGZhvYToqCwDAg6AT5QQTXo", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: FIXTURE_WALLET, tokenAccount: "9Di2MQ5CqmJ2DQee2MTb5TGZhvYToqCwDAg6AT5QQTXo", mint: GTA6_MINT, rawTokenAmount: { tokenAmount: `-${GTA6_RAW_POSITION.toString()}`, decimals: 6 } }] },
    { account: "PoolWsolVault11111111111111111111111111111111", nativeBalanceChange: 0, tokenBalanceChanges: [{ userAccount: "A9F9VoR7sf8tUAeqXDCZjXJ4NhyvHC3DeRB9buMQgGfZ", tokenAccount: "PoolWsolVault11111111111111111111111111111111", mint: "So11111111111111111111111111111111111111112", rawTokenAmount: { tokenAmount: "-399123558197", decimals: 9 } }] },
  ],
};

export const accountCloseFixture: HeliusTransaction = {
  signature: "31vcmjK8HpmcKHGDUDmq2UMeB2AeMZfWJJaTKwQaAFoRLpLiEF5aGmJyR27kyYy9qoTfdGHjsBEmUwdWVqD2y3Be",
  slot: 451315750, timestamp: 1790597611, type: "UNKNOWN", source: "UNKNOWN", fee: 5_000, feePayer: FIXTURE_WALLET, transactionError: null,
  tokenTransfers: [], nativeTransfers: [],
  accountData: [
    { account: FIXTURE_WALLET, nativeBalanceChange: 1_508_840, tokenBalanceChanges: [] },
    { account: "9Di2MQ5CqmJ2DQee2MTb5TGZhvYToqCwDAg6AT5QQTXo", nativeBalanceChange: -1_513_840, tokenBalanceChanges: [] },
    { account: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", nativeBalanceChange: 0, tokenBalanceChanges: [] },
  ],
};

export const accountCloseCanonicalEvidence: CanonicalEconomicEvidence = { accountClosures: [{
  account: "9Di2MQ5CqmJ2DQee2MTb5TGZhvYToqCwDAg6AT5QQTXo", mint: GTA6_MINT,
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", preRawAmount: 0n, decimals: 6, rentReclaimedLamports: 1_513_840n,
}], nativeTransfer: null };

export const nativeTransferOutFixture: HeliusTransaction = {
  signature: "4zfLxYiuSj34feU4ALxAG43Eu6RVWZmgYgiasrcBeb5c1BfdzwJW8QoGhMmM4jiaSHiVGW3BmPNqKvKCHUGR5WSA",
  slot: 451317209, timestamp: 1790598000, type: "TRANSFER", source: "SYSTEM_PROGRAM", fee: 10_000, feePayer: FIXTURE_WALLET, transactionError: null,
  tokenTransfers: [],
  nativeTransfers: [{ fromUserAccount: FIXTURE_WALLET, toUserAccount: "ApDXXohyf1g8nPae1xKod6KRexaJ4oGCoHjsqSk8gotN", amount: 445_722_893_198 }],
  accountData: [{ account: FIXTURE_WALLET, nativeBalanceChange: -445_722_903_198, tokenBalanceChanges: [] }],
};
