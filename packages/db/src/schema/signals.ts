import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ratio, score, usdAmount } from "./common";
import { alertLevel, dataQuality, deliveryStatus, signalType } from "./enums";
import { tokenMarketSnapshots, tokenRiskSnapshots, tokens } from "./chain";
import { trackedWallets, walletClassifications, walletScores } from "./wallets";

export const signalScoreVersions = pgTable("signal_score_versions", {
  id: id(),
  version: text("version").notNull(),
  formula: jsonb("formula").$type<Record<string, unknown>>().notNull(),
  activatedAt: timestamp("activated_at", { withTimezone: true }).notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
}, (table) => [uniqueIndex("signal_score_versions_version_uq").on(table.version)]);

export const signals = pgTable("signals", {
  id: id(),
  tokenId: uuid("token_id").references(() => tokens.id).notNull(),
  type: signalType("type").notNull(),
  level: alertLevel("level").notNull(),
  score: score("score").notNull(),
  scoreVersionId: uuid("score_version_id").references(() => signalScoreVersions.id).notNull(),
  componentScores: jsonb("component_scores").$type<Record<string, number>>().notNull(),
  inputs: jsonb("inputs").$type<Record<string, unknown>>().notNull(),
  explanation: jsonb("explanation").$type<readonly string[]>().notNull(),
  detectionPriceUsd: usdAmount("detection_price_usd"),
  detectionMarketCapUsd: usdAmount("detection_market_cap_usd"),
  detectionLiquidityUsd: usdAmount("detection_liquidity_usd"),
  marketSnapshotId: uuid("market_snapshot_id").references(() => tokenMarketSnapshots.id),
  riskSnapshotId: uuid("risk_snapshot_id").references(() => tokenRiskSnapshots.id),
  rawWalletCount: integer("raw_wallet_count").notNull(),
  independentClusterCount: integer("independent_cluster_count").notNull(),
  independenceWeight: ratio("independence_weight").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
}, (table) => [
  check("signals_score_range", sql`${table.score} between 0 and 100`),
  index("signals_recent_idx").on(table.detectedAt),
  index("signals_token_time_idx").on(table.tokenId, table.detectedAt),
]);

export const signalWallets = pgTable("signal_wallets", {
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }).notNull(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id).notNull(),
  walletScoreId: uuid("wallet_score_id").references(() => walletScores.id),
  walletClassificationId: uuid("wallet_classification_id"),
  independenceCluster: text("independence_cluster").notNull(),
  independenceWeight: ratio("independence_weight").notNull(),
  role: text("role").notNull(),
  purchaseValueUsd: usdAmount("purchase_value_usd"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.signalId, table.walletId, table.role] }),
  foreignKey({ name: "sig_wallet_class_fk", columns: [table.walletClassificationId], foreignColumns: [walletClassifications.id] }),
]);

export const signalSnapshots = pgTable("signal_snapshots", {
  id: id(),
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }).notNull(),
  kind: text("kind").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  data: jsonb("data").$type<Record<string, unknown>>().notNull(),
}, (table) => [uniqueIndex("signal_snapshots_kind_time_uq").on(table.signalId, table.kind, table.observedAt)]);

export const signalOutcomes = pgTable("signal_outcomes", {
  id: id(),
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }).notNull(),
  horizonSeconds: integer("horizon_seconds").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
  measuredAt: timestamp("measured_at", { withTimezone: true }),
  priceUsd: usdAmount("price_usd"),
  returnFromDetection: ratio("return_from_detection"),
  returnFromNotification: ratio("return_from_notification"),
  maximumFavorableExcursion: ratio("maximum_favorable_excursion"),
  maximumAdverseExcursion: ratio("maximum_adverse_excursion"),
  peakPriceUsd: usdAmount("peak_price_usd"),
  lowestPriceUsd: usdAmount("lowest_price_usd"),
  timeToPeakSeconds: integer("time_to_peak_seconds"),
  liquidityUsd: usdAmount("liquidity_usd"),
  quality: dataQuality("quality").notNull(),
  failureReason: text("failure_reason"),
}, (table) => [
  uniqueIndex("signal_outcomes_horizon_uq").on(table.signalId, table.horizonSeconds),
  index("signal_outcomes_pending_idx").on(table.dueAt, table.measuredAt),
]);

export const alerts = pgTable("alerts", {
  id: id(),
  signalId: uuid("signal_id").references(() => signals.id, { onDelete: "cascade" }).notNull(),
  level: alertLevel("level").notNull(),
  deduplicationKey: text("deduplication_key").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  notificationPriceUsd: usdAmount("notification_price_usd"),
  createdAt: createdAt(),
}, (table) => [uniqueIndex("alerts_deduplication_key_uq").on(table.deduplicationKey)]);

export const alertDeliveries = pgTable("alert_deliveries", {
  id: id(),
  alertId: uuid("alert_id").references(() => alerts.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(),
  destinationKey: text("destination_key").notNull(),
  status: deliveryStatus("status").default("PENDING").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  externalId: text("external_id"),
  lastErrorCode: text("last_error_code"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  createdAt: createdAt(),
}, (table) => [
  uniqueIndex("alert_deliveries_destination_uq").on(table.alertId, table.provider, table.destinationKey),
  index("alert_deliveries_pending_idx").on(table.status, table.nextAttemptAt),
]);
