import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, priceQuote, rawAmount, slot, usdAmount } from "./common";
import { dataQuality, priceObservationStatus, pricingState, pricingStatus, processingStatus, tradeSide, valuationBasis } from "./enums";
import { trackedWallets } from "./wallets";

export const tokens = pgTable("tokens", {
  id: id(),
  mint: text("mint").notNull(),
  decimals: integer("decimals"),
  symbol: text("symbol"),
  name: text("name"),
  createdOnChainAt: timestamp("created_on_chain_at", { withTimezone: true }),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("tokens_mint_uq").on(table.mint)]);

export const providerEvents = pgTable("provider_events", {
  id: id(),
  provider: text("provider").notNull(),
  externalEventId: text("external_event_id").notNull(),
  payloadHash: text("payload_hash").notNull(),
  eventType: text("event_type").notNull(),
  status: processingStatus("status").default("RECEIVED").notNull(),
  signature: text("signature"),
  slot: slot(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  payloadSummary: jsonb("payload_summary").$type<Record<string, unknown>>().notNull(),
  /** Validated, size-bounded provider payload kept so processing can happen asynchronously and be replayed. */
  payload: jsonb("payload").$type<Record<string, unknown>>(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  lastErrorCode: text("last_error_code"),
}, (table) => [
  uniqueIndex("provider_events_identity_uq").on(table.provider, table.externalEventId),
  index("provider_events_status_received_idx").on(table.status, table.receivedAt),
  index("provider_events_signature_idx").on(table.signature),
]);

export const walletTransactions = pgTable("wallet_transactions", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  providerEventId: uuid("provider_event_id").references(() => providerEvents.id).notNull(),
  signature: text("signature").notNull(),
  instructionIndex: integer("instruction_index").notNull(),
  innerInstructionIndex: integer("inner_instruction_index").default(-1).notNull(),
  kind: text("kind").notNull(),
  slot: slot().notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  /** confirmed | finalized | dropped. Only finalized rows feed accounting. */
  finality: text("finality").notNull(),
  ingestionSource: text("ingestion_source").default("helius-history").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
  finalityCheckedAt: timestamp("finality_checked_at", { withTimezone: true }),
  succeeded: boolean("succeeded").notNull(),
  normalizedPayload: jsonb("normalized_payload").$type<Record<string, unknown>>().notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_transactions_identity_uq").on(table.walletId, table.signature, table.instructionIndex, table.innerInstructionIndex),
  index("wallet_transactions_wallet_time_idx").on(table.walletId, table.occurredAt),
  index("wallet_transactions_signature_idx").on(table.signature),
  index("wallet_transactions_finality_idx").on(table.finality, table.firstSeenAt),
]);

/** Immutable, provider-attributed price observations; the exact rows accounting used are referenced by trades. */
export const historicalPricePoints = pgTable("historical_price_points", {
  id: id(),
  provider: text("provider").notNull(),
  assetMint: text("asset_mint").notNull(),
  granularitySeconds: integer("granularity_seconds").notNull(),
  bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
  status: priceObservationStatus("status").notNull(),
  priceUsd: usdAmount("price_usd"),
  /** Start of the candle the price was taken from (may precede bucketStart when a gap was bridged). */
  observedAt: timestamp("observed_at", { withTimezone: true }),
  confidenceBps: integer("confidence_bps"),
  reason: text("reason"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("historical_price_identity_uq").on(table.provider, table.assetMint, table.granularitySeconds, table.bucketStart),
  index("historical_price_asset_time_idx").on(table.assetMint, table.bucketStart),
]);

export const walletTrades = pgTable("wallet_trades", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  transactionId: uuid("transaction_id").references(() => walletTransactions.id, { onDelete: "cascade" }).notNull(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  side: tradeSide("side").notNull(),
  rawTokenAmount: rawAmount("raw_token_amount").notNull(),
  tokenDecimals: integer("token_decimals").notNull(),
  rawBaseAmount: rawAmount("raw_base_amount"),
  baseDecimals: integer("base_decimals"),
  baseMint: text("base_mint"),
  estimatedUsdValue: usdAmount("estimated_usd_value"),
  feeUsd: usdAmount("fee_usd"),
  executionPriceUsd: usdAmount("execution_price_usd"),
  pricingStatus: pricingStatus("pricing_status").default("MISSING_PRICE").notNull(),
  // Swap flows: what the wallet actually spent and received.
  spentMint: text("spent_mint"),
  spentRawAmount: rawAmount("spent_raw_amount"),
  spentDecimals: integer("spent_decimals"),
  receivedMint: text("received_mint"),
  receivedRawAmount: rawAmount("received_raw_amount"),
  receivedDecimals: integer("received_decimals"),
  /** Quote units per whole token, from the swap's own flows. */
  executionPriceQuote: priceQuote("execution_price_quote"),
  /** How the quote amount was obtained: EXACT, DERIVED or AMBIGUOUS. */
  considerationBasis: text("consideration_basis"),
  pricingState: pricingState("pricing_state").default("RECONSTRUCTED_UNPRICED").notNull(),
  valuationBasis: valuationBasis("valuation_basis").default("UNAVAILABLE").notNull(),
  pricingSource: text("pricing_source"),
  pricingAt: timestamp("pricing_at", { withTimezone: true }),
  pricingConfidenceBps: integer("pricing_confidence_bps"),
  quoteUsdPrice: usdAmount("quote_usd_price"),
  priceObservationId: uuid("price_observation_id").references(() => historicalPricePoints.id),
  pricingIssues: jsonb("pricing_issues").$type<readonly string[]>().default([]).notNull(),
  // Costs and normalization that are explicitly NOT swap consideration.
  feeLamports: rawAmount("fee_lamports"),
  networkFeeLamports: rawAmount("network_fee_lamports"),
  tipLamports: rawAmount("tip_lamports"),
  rentExcludedLamports: rawAmount("rent_excluded_lamports"),
  unattributedLamports: rawAmount("unattributed_lamports"),
  wsolNormalized: boolean("wsol_normalized").default(false).notNull(),
  routed: boolean("routed").default(false).notNull(),
  routeAssets: jsonb("route_assets").$type<readonly string[]>().default([]).notNull(),
  venue: text("venue"),
  quality: dataQuality("quality").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_trades_transaction_token_side_uq").on(table.transactionId, table.tokenId, table.side),
  index("wallet_trades_wallet_token_time_idx").on(table.walletId, table.tokenId, table.occurredAt),
  index("wallet_trades_pricing_state_idx").on(table.walletId, table.pricingState),
  index("wallet_trades_token_side_time_idx").on(table.tokenId, table.side, table.occurredAt),
  check("wallet_trades_decimals_range", sql`${table.tokenDecimals} between 0 and 30`),
]);

export const tokenMarketSnapshots = pgTable("token_market_snapshots", {
  id: id(),
  tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  priceUsd: usdAmount("price_usd"),
  marketCapUsd: usdAmount("market_cap_usd"),
  fdvUsd: usdAmount("fdv_usd"),
  liquidityUsd: usdAmount("liquidity_usd"),
  volume24hUsd: usdAmount("volume_24h_usd"),
  holderCount: integer("holder_count"),
  quality: dataQuality("quality").notNull(),
}, (table) => [
  uniqueIndex("token_market_observation_uq").on(table.tokenId, table.provider, table.observedAt),
  index("token_market_recent_idx").on(table.tokenId, table.observedAt),
]);

export const tokenRiskSnapshots = pgTable("token_risk_snapshots", {
  id: id(),
  tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  score: integer("score").notNull(),
  scoreVersion: text("score_version").notNull(),
  indicators: jsonb("indicators").$type<Record<string, unknown>>().notNull(),
  top10ConcentrationBps: integer("top_10_concentration_bps"),
  creatorConcentrationBps: integer("creator_concentration_bps"),
  mintAuthorityEnabled: boolean("mint_authority_enabled"),
  freezeAuthorityEnabled: boolean("freeze_authority_enabled"),
  quality: dataQuality("quality").notNull(),
}, (table) => [index("token_risk_recent_idx").on(table.tokenId, table.observedAt), check("token_risk_score_range", sql`${table.score} between 0 and 100`)]);
