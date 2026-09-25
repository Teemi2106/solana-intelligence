import { relations, sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, evidence, id, ratio, score, usdAmount } from "./common";
import { dataQuality, relationshipType, walletClassification, walletStatus } from "./enums";

export const trackedWallets = pgTable("tracked_wallets", {
  id: id(),
  address: text("address").notNull(),
  status: walletStatus("status").default("ACTIVE").notNull(),
  displayName: text("display_name"),
  monitoringStartedAt: timestamp("monitoring_started_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("tracked_wallets_address_uq").on(table.address), index("tracked_wallets_status_idx").on(table.status)]);

export const walletLabels = pgTable("wallet_labels", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  label: text("label").notNull(),
  source: text("source").notNull(),
  createdAt: createdAt(),
}, (table) => [primaryKey({ columns: [table.walletId, table.label, table.source] })]);

export const walletScoreVersions = pgTable("wallet_score_versions", {
  id: id(),
  version: text("version").notNull(),
  formula: jsonb("formula").$type<Record<string, unknown>>().notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => [uniqueIndex("wallet_score_versions_version_uq").on(table.version)]);

export const walletScores = pgTable("wallet_scores", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  scoreVersionId: uuid("score_version_id").references(() => walletScoreVersions.id).notNull(),
  value: score("value").notNull(),
  componentScores: jsonb("component_scores").$type<Record<string, number>>().notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  quality: dataQuality("quality").notNull(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  check("wallet_scores_value_range", sql`${table.value} between 0 and 100`),
  index("wallet_scores_as_of_idx").on(table.walletId, table.validFrom, table.validTo),
]);

export const walletClassifications = pgTable("wallet_classifications", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  classification: walletClassification("classification").notNull(),
  earlyAccessScore: score("early_access_score"),
  confidenceBps: integer("confidence_bps").notNull(),
  evidence: evidence(),
  validFrom: timestamp("valid_from", { withTimezone: true }).notNull(),
  validTo: timestamp("valid_to", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  check("wallet_classifications_confidence_range", sql`${table.confidenceBps} between 0 and 10000`),
  check("wallet_classifications_early_score_range", sql`${table.earlyAccessScore} is null or ${table.earlyAccessScore} between 0 and 100`),
  index("wallet_classifications_as_of_idx").on(table.walletId, table.validFrom, table.validTo),
]);

export const walletPerformanceSnapshots = pgTable("wallet_performance_snapshots", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  windowDays: integer("window_days").notNull(),
  realizedPnlUsd: usdAmount("realized_pnl_usd"),
  unrealizedPnlUsd: usdAmount("unrealized_pnl_usd"),
  completedTrades: integer("completed_trades").notNull(),
  profitableTrades: integer("profitable_trades").notNull(),
  losingTrades: integer("losing_trades").notNull(),
  medianRoi: ratio("median_roi"),
  averageRoi: ratio("average_roi"),
  largestWinnerUsd: usdAmount("largest_winner_usd"),
  largestLoserUsd: usdAmount("largest_loser_usd"),
  profitExcludingLargestUsd: usdAmount("profit_excluding_largest_usd"),
  largestTradeContribution: ratio("largest_trade_contribution"),
  metrics: jsonb("metrics").$type<Record<string, string | number | boolean | null>>().notNull(),
  quality: dataQuality("quality").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("wallet_performance_observation_uq").on(table.walletId, table.windowDays, table.observedAt),
  index("wallet_performance_recent_idx").on(table.walletId, table.observedAt),
]);

export const walletRelationships = pgTable("wallet_relationships", {
  id: id(),
  sourceAddress: text("source_address").notNull(),
  targetAddress: text("target_address").notNull(),
  type: relationshipType("type").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
  observationCount: integer("observation_count").default(1).notNull(),
  confidenceBps: integer("confidence_bps").notNull(),
  evidence: evidence(),
}, (table) => [
  uniqueIndex("wallet_relationship_identity_uq").on(table.sourceAddress, table.targetAddress, table.type),
  index("wallet_relationship_target_idx").on(table.targetAddress, table.type),
  check("wallet_relationship_confidence_range", sql`${table.confidenceBps} between 0 and 10000`),
]);

export const trackedWalletRelations = relations(trackedWallets, ({ many }) => ({
  labels: many(walletLabels),
  scores: many(walletScores),
  classifications: many(walletClassifications),
  performanceSnapshots: many(walletPerformanceSnapshots),
}));
