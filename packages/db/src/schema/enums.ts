import { pgEnum } from "drizzle-orm/pg-core";

export const walletStatus = pgEnum("wallet_status", ["ACTIVE", "PAUSED", "ARCHIVED"]);
export const walletClassification = pgEnum("wallet_classification", [
  "COPYABLE_SMART_MONEY",
  "EARLY_ACCESS_ALLOCATION_PATTERN",
  "RELATED_TEAM_LINKED",
  "UNKNOWN_INSUFFICIENT_EVIDENCE",
]);
export const tradeSide = pgEnum("trade_side", ["BUY", "SELL"]);
export const pricingStatus = pgEnum("pricing_status", ["MISSING_PRICE", "PRICED"]);
export const pricingState = pgEnum("pricing_state", [
  "RECONSTRUCTED_UNPRICED",
  "PRICED_FROM_STABLECOIN_FLOW",
  "PRICED_FROM_SOL_FLOW",
  "PRICED_FROM_EXTERNAL_HISTORY",
  "MISSING_QUOTE_USD_PRICE",
  "MISSING_HISTORICAL_PRICE",
  "AMBIGUOUS_CONSIDERATION",
]);
export const valuationBasis = pgEnum("valuation_basis", ["EXACT", "DERIVED", "EXTERNAL", "UNAVAILABLE"]);
export const priceObservationStatus = pgEnum("price_observation_status", ["FOUND", "NOT_AVAILABLE", "UNSUPPORTED"]);
export const dataQuality = pgEnum("data_quality", ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"]);
export const signalType = pgEnum("signal_type", [
  "SMART_MONEY_CONVERGENCE",
  "EARLY_MOVEMENT",
  "EARLY_MOVEMENT_WITH_PUBLIC_CONFIRMATION",
]);
export const alertLevel = pgEnum("alert_level", ["INFO", "WATCH", "HIGH", "CRITICAL"]);
export const processingStatus = pgEnum("processing_status", ["RECEIVED", "QUEUED", "PROCESSING", "PROCESSED", "FAILED"]);
export const deliveryStatus = pgEnum("delivery_status", ["PENDING", "DELIVERED", "RETRYING", "FAILED"]);
export const ingestionStatus = pgEnum("ingestion_status", ["PENDING", "RUNNING", "COMPLETED", "FAILED", "PAUSED"]);
export const transactionKind = pgEnum("transaction_kind", ["SWAP", "TRANSFER", "AMBIGUOUS", "OTHER"]);
export const flowDirection = pgEnum("flow_direction", ["IN", "OUT"]);
export const basisSource = pgEnum("basis_source", ["PURCHASE", "TRANSFER_UNKNOWN", "ADJUSTMENT"]);
export const relationshipType = pgEnum("relationship_type", [
  "FUNDED_BY",
  "FUNDED",
  "TOKEN_RECEIVED_FROM",
  "DEPLOYER_TRANSFER",
  "REPEATED_COUNTERPARTY",
  "POSSIBLY_RELATED",
  "COMMON_FUNDING_SOURCE",
]);
