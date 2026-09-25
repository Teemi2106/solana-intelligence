declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type WalletAddress = Brand<string, "WalletAddress">;
export type TokenMint = Brand<string, "TokenMint">;
export type TransactionSignature = Brand<string, "TransactionSignature">;
export type EventId = Brand<string, "EventId">;

export type WalletClassification =
  | "COPYABLE_SMART_MONEY"
  | "EARLY_ACCESS_ALLOCATION_PATTERN"
  | "RELATED_TEAM_LINKED"
  | "UNKNOWN_INSUFFICIENT_EVIDENCE";

export type WalletEventKind =
  | "WALLET_BOUGHT_TOKEN"
  | "WALLET_SOLD_TOKEN"
  | "WALLET_RECEIVED_TOKEN"
  | "WALLET_TRANSFERRED_TOKEN";

export interface NormalizedWalletEvent {
  readonly eventId: EventId;
  readonly kind: WalletEventKind;
  readonly wallet: WalletAddress;
  readonly mint: TokenMint;
  readonly signature: TransactionSignature;
  readonly occurredAt: Date;
  readonly slot: bigint;
  readonly finality: "processed" | "confirmed" | "finalized";
  readonly rawTokenAmount: bigint;
  readonly tokenDecimals: number;
  readonly source: string;
  readonly confidenceBps: number;
}

export interface HealthCheck {
  readonly name: string;
  readonly status: "up" | "down";
  readonly latencyMs: number;
  readonly detail?: string;
}
