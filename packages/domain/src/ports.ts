import type { HealthCheck, TokenMint, TransactionSignature, WalletAddress } from "./types";

export interface BlockchainProvider {
  getWalletHistory(address: WalletAddress, options?: { cursor?: string; limit?: number }): Promise<{
    transactions: readonly HistoricalWalletTransaction[];
    nextCursor?: string;
  }>;
  checkHealth(): Promise<HealthCheck>;
}

export interface HistoricalTokenFlow {
  readonly mint: TokenMint;
  readonly direction: "IN" | "OUT";
  readonly rawAmount: bigint;
  readonly decimals: number;
  readonly account: string | null;
  readonly counterparty: string | null;
}

/**
 * Provider-neutral facts needed to separate swap consideration from rent, tips and fees.
 * All amounts are integer lamports / raw units; none is derived from floating point.
 */
export interface HistoricalSettlementFacts {
  /** Provider-reported venue/aggregator (e.g. PUMP_AMM, JUPITER). */
  readonly venue: string | null;
  /** Lamports the wallet locked (+) or recovered (-) as rent in wallet-owned token accounts, excluding wSOL principal. */
  readonly walletTokenAccountRentLamports: bigint;
  /** Sum of wSOL balance changes of accounts NOT owned by the wallet; null when no such change was observed. */
  readonly counterpartyWsolDeltaLamports: bigint | null;
  /** Lamports the wallet paid to known bundle-tip accounts. */
  readonly tipLamports: bigint;
  /** Every mint that moved anywhere in the transaction (used to detect routed intermediates). */
  readonly movedMints: readonly string[];
}

export interface HistoricalWalletTransaction {
  readonly signature: TransactionSignature;
  readonly slot: bigint;
  readonly occurredAt: Date;
  readonly succeeded: boolean;
  readonly providerType: string;
  readonly feeLamports: bigint;
  readonly feePayerIsWallet: boolean;
  readonly tokenFlows: readonly HistoricalTokenFlow[];
  readonly nativeSolDeltaLamports: bigint;
  readonly source: string;
  readonly settlement: HistoricalSettlementFacts;
  readonly quality: "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";
  readonly issues: readonly string[];
}

export interface MarketSnapshot {
  readonly mint: TokenMint;
  readonly observedAt: Date;
  readonly priceUsd: string | null;
  readonly liquidityUsd: string | null;
  readonly marketCapUsd: string | null;
  readonly source: string;
  readonly confidenceBps: number;
}

export interface MarketDataProvider {
  getSnapshot(mint: TokenMint, observedAt: Date): Promise<MarketSnapshot>;
  checkHealth(): Promise<HealthCheck>;
}

export interface NotificationMessage {
  readonly deduplicationKey: string;
  readonly severity: "INFO" | "WATCH" | "HIGH" | "CRITICAL";
  readonly text: string;
  readonly analysisUrl?: URL;
}

export interface NotificationProvider {
  deliver(message: NotificationMessage): Promise<{ externalId: string }>;
  checkHealth(): Promise<HealthCheck>;
}

// ---- Live ingestion boundaries ---------------------------------------------------------------------

/** What the provider reports about its live wallet-activity subscription. */
export interface LiveSubscriptionState {
  readonly externalId: string;
  readonly webhookUrl: string;
  readonly addresses: readonly string[];
  readonly active: boolean;
}

/** Maintains a provider-side subscription for a set of wallet addresses. The database, not the provider, is the source of truth. */
export interface LiveSubscriptionProvider {
  readonly maxAddresses: number;
  /** Finds the subscription that delivers to this system's URL, if any. */
  findSubscription(): Promise<LiveSubscriptionState | null>;
  createSubscription(addresses: readonly string[]): Promise<LiveSubscriptionState>;
  /** Replaces the whole address set and returns what the provider reports afterwards (read-back). */
  replaceAddresses(externalId: string, addresses: readonly string[]): Promise<LiveSubscriptionState>;
  setActive(externalId: string, active: boolean): Promise<LiveSubscriptionState>;
  checkHealth(): Promise<HealthCheck>;
}

export type FinalityStatus = "NOT_FOUND" | "CONFIRMED" | "FINALIZED" | "FAILED";

export interface FinalityProvider {
  getFinality(signatures: readonly string[]): Promise<ReadonlyMap<string, FinalityStatus>>;
}

export type TokenLaunchResult =
  | { readonly status: "FOUND"; readonly firstActivityAt: Date; readonly firstActivitySlot: bigint; readonly firstSignature: string; readonly firstSigner: string | null }
  | { readonly status: "UNAVAILABLE"; readonly reason: string };

export interface TokenLaunchProvider {
  getFirstActivity(mint: string): Promise<TokenLaunchResult>;
}
