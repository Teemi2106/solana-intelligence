import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, rawAmount, ratio, usdAmount } from "./common";
import { basisSource, dataQuality, flowDirection, ingestionStatus } from "./enums";
import { tokens, walletTransactions, walletTrades } from "./chain";
import { trackedWallets, walletClassifications } from "./wallets";

export const walletIngestionRuns = pgTable("wallet_ingestion_runs", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: ingestionStatus("status").default("PENDING").notNull(),
  cursor: text("cursor"),
  pagesProcessed: integer("pages_processed").default(0).notNull(),
  transactionsSeen: integer("transactions_seen").default(0).notNull(),
  transactionsStored: integer("transactions_stored").default(0).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("wallet_ingestion_idempotency_uq").on(table.idempotencyKey),
  index("wallet_ingestion_wallet_status_idx").on(table.walletId, table.status, table.createdAt),
]);

export const walletIngestionCheckpoints = pgTable("wallet_ingestion_checkpoints", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).primaryKey(),
  provider: text("provider").notNull(),
  cursor: text("cursor"),
  oldestSlot: rawAmount("oldest_slot"),
  newestSlot: rawAmount("newest_slot"),
  completed: boolean("completed").default(false).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const transactionTokenFlows = pgTable("transaction_token_flows", {
  id: id(),
  transactionId: uuid("transaction_id").notNull(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  direction: flowDirection("direction").notNull(),
  rawAmount: rawAmount("raw_amount").notNull(),
  decimals: integer("decimals").notNull(),
  account: text("account"),
  counterparty: text("counterparty"),
  flowIndex: integer("flow_index").notNull(),
  isFee: boolean("is_fee").default(false).notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("transaction_token_flows_identity_uq").on(table.transactionId, table.flowIndex),
  index("transaction_token_flows_token_idx").on(table.tokenId, table.transactionId),
  foreignKey({ name: "token_flow_transaction_fk", columns: [table.transactionId], foreignColumns: [walletTransactions.id] }).onDelete("cascade"),
  check("transaction_token_flows_decimals_range", sql`${table.decimals} between 0 and 30`),
]);

export const walletInventoryLots = pgTable("wallet_inventory_lots", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  sourceTradeId: uuid("source_trade_id").references(() => walletTrades.id),
  sourceTransactionId: uuid("source_transaction_id").notNull(),
  basisSource: basisSource("basis_source").notNull(),
  acquiredRawAmount: rawAmount("acquired_raw_amount").notNull(),
  remainingRawAmount: rawAmount("remaining_raw_amount").notNull(),
  costBasisUsd: usdAmount("cost_basis_usd"),
  remainingCostBasisUsd: usdAmount("remaining_cost_basis_usd"),
  confidenceBps: integer("confidence_bps"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }).notNull(),
  quality: dataQuality("quality").notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_inventory_source_uq").on(table.walletId, table.sourceTransactionId, table.tokenId),
  index("wallet_inventory_fifo_idx").on(table.walletId, table.tokenId, table.acquiredAt),
  foreignKey({ name: "inventory_source_tx_fk", columns: [table.sourceTransactionId], foreignColumns: [walletTransactions.id] }),
]);

export const walletRealizations = pgTable("wallet_realizations", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  sellTradeId: uuid("sell_trade_id").references(() => walletTrades.id).notNull(),
  lotId: uuid("lot_id").references(() => walletInventoryLots.id).notNull(),
  rawAmount: rawAmount("raw_amount").notNull(),
  proceedsUsd: usdAmount("proceeds_usd"),
  costBasisUsd: usdAmount("cost_basis_usd"),
  realizedPnlUsd: usdAmount("realized_pnl_usd"),
  roi: ratio("roi"),
  holdingSeconds: integer("holding_seconds"),
  confidenceBps: integer("confidence_bps"),
  issues: jsonb("issues").$type<readonly string[]>().default([]).notNull(),
  quality: dataQuality("quality").notNull(),
  realizedAt: timestamp("realized_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_realization_sell_lot_uq").on(table.sellTradeId, table.lotId),
  index("wallet_realization_wallet_time_idx").on(table.walletId, table.realizedAt),
]);

export const walletPositions = pgTable("wallet_positions", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  rawAmount: rawAmount("raw_amount").notNull(),
  knownCostBasisUsd: usdAmount("known_cost_basis_usd"),
  unknownBasisRawAmount: rawAmount("unknown_basis_raw_amount").default("0").notNull(),
  marketValueUsd: usdAmount("market_value_usd"),
  unrealizedPnlUsd: usdAmount("unrealized_pnl_usd"),
  priceObservedAt: timestamp("price_observed_at", { withTimezone: true }),
  quality: dataQuality("quality").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("wallet_positions_identity_uq").on(table.walletId, table.tokenId),
]);

export const walletClassificationEvidence = pgTable("wallet_classification_evidence", {
  id: id(),
  classificationId: uuid("classification_id").notNull(),
  transactionId: uuid("transaction_id"),
  evidenceType: text("evidence_type").notNull(),
  confidenceBps: integer("confidence_bps").notNull(),
  facts: jsonb("facts").$type<Record<string, unknown>>().notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  foreignKey({ name: "wallet_class_evidence_fk", columns: [table.classificationId], foreignColumns: [walletClassifications.id] }).onDelete("cascade"),
  foreignKey({ name: "class_evidence_tx_fk", columns: [table.transactionId], foreignColumns: [walletTransactions.id] }),
  uniqueIndex("wallet_class_evidence_identity_uq").on(table.classificationId, table.evidenceType, table.transactionId),
  check("wallet_class_evidence_confidence", sql`${table.confidenceBps} between 0 and 10000`),
]);
