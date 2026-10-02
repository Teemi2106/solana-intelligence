import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, rawAmount } from "./common";
import { tokens, walletEconomicActions, walletTrades, walletTransactions } from "./chain";
import { trackedWallets } from "./wallets";

export const walletBehaviorObservations = pgTable("wallet_behavior_observations", {
  id: id(), walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  transactionId: uuid("transaction_id").references(() => walletTransactions.id, { onDelete: "cascade" }),
  actionId: uuid("action_id").references(() => walletEconomicActions.id, { onDelete: "cascade" }), tokenId: uuid("token_id").references(() => tokens.id),
  sourceType: text("source_type").notNull(), sourceId: text("source_id").notNull(), featureKind: text("feature_kind").notNull(), family: text("family").notNull(),
  sellTradeId: uuid("sell_trade_id").references(() => walletTrades.id), acquisitionTradeId: uuid("acquisition_trade_id").references(() => walletTrades.id),
  realizedRawAmount: rawAmount("realized_raw_amount"), accountingMethodologyVersion: text("accounting_methodology_version"),
  numericValue: numeric("numeric_value", { precision: 78, scale: 18 }), categoricalValue: text("categorical_value"), unit: text("unit").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(), orderingKey: text("ordering_key").notNull(), quality: text("quality").notNull(),
  methodologyVersion: text("methodology_version").notNull(), evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(), includedInBaseline: boolean("included_in_baseline").default(true).notNull(), createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_behavior_observation_identity_uq").on(table.sourceType, table.sourceId, table.featureKind, table.methodologyVersion),
  index("wallet_behavior_observation_feature_time_idx").on(table.walletId, table.featureKind, table.occurredAt),
  index("wallet_behavior_observation_order_idx").on(table.walletId, table.orderingKey),
  index("wallet_behavior_observation_realization_idx").on(table.walletId, table.featureKind, table.accountingMethodologyVersion, table.sellTradeId),
  check("wallet_behavior_observation_one_value", sql`(${table.numericValue} is null) <> (${table.categoricalValue} is null)`),
]);

export const walletBehaviorBaselines = pgTable("wallet_behavior_baselines", {
  id: id(), walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(), featureKind: text("feature_kind").notNull(), cohort: text("cohort").default("ALL").notNull(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(), windowEnd: timestamp("window_end", { withTimezone: true }).notNull(), throughOrderingKey: text("through_ordering_key").notNull(),
  observationCount: integer("observation_count").notNull(), coverageDays: integer("coverage_days").notNull(), quality: text("quality").notNull(), historyComplete: boolean("history_complete").notNull(), completenessBps: integer("completeness_bps"),
  statistics: jsonb("statistics").$type<Record<string, unknown>>().notNull(), methodologyVersion: text("methodology_version").notNull(), evaluationGeneration: integer("evaluation_generation").default(1).notNull(), generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(), createdAt: createdAt(),
}, (table) => [uniqueIndex("wallet_behavior_baseline_identity_uq").on(table.walletId, table.featureKind, table.cohort, table.throughOrderingKey, table.methodologyVersion, table.evaluationGeneration), index("wallet_behavior_baseline_latest_idx").on(table.walletId, table.featureKind, table.generatedAt)]);

export const walletBehaviorIncidents = pgTable("wallet_behavior_incidents", {
  id: id(), walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(), anchorActionId: uuid("anchor_action_id").references(() => walletEconomicActions.id).notNull(),
  firstOrderingKey: text("first_ordering_key").notNull(), latestOrderingKey: text("latest_ordering_key").notNull(), openedAt: timestamp("opened_at", { withTimezone: true }).notNull(), latestAt: timestamp("latest_at", { withTimezone: true }).notNull(),
  severity: text("severity").notNull(), status: text("status").default("OPEN").notNull(), revision: integer("revision").default(1).notNull(), ruleIds: jsonb("rule_ids").$type<readonly string[]>().notNull(), families: jsonb("families").$type<readonly string[]>().notNull(),
  baselineQuality: text("baseline_quality").notNull(), methodologyVersion: text("methodology_version").notNull(), evaluationGeneration: integer("evaluation_generation").default(1).notNull(), createdAt: createdAt(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("wallet_behavior_incident_anchor_uq").on(table.anchorActionId, table.methodologyVersion, table.evaluationGeneration), index("wallet_behavior_incident_wallet_time_idx").on(table.walletId, table.latestAt)]);

export const walletAnomalies = pgTable("wallet_anomalies", {
  id: id(), walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(), transactionId: uuid("transaction_id").references(() => walletTransactions.id).notNull(), actionId: uuid("action_id").references(() => walletEconomicActions.id).notNull(), incidentId: uuid("incident_id").references(() => walletBehaviorIncidents.id), baselineId: uuid("baseline_id").references(() => walletBehaviorBaselines.id),
  featureKind: text("feature_kind").notNull(), family: text("family").notNull(), observed: jsonb("observed").$type<Record<string, unknown>>().notNull(), percentileLowerBps: integer("percentile_lower_bps"), percentileUpperBps: integer("percentile_upper_bps"), baselineQuality: text("baseline_quality").notNull(),
  severityContribution: text("severity_contribution").notNull(), ruleId: text("rule_id").notNull(), evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(), tokenMarketSnapshotId: uuid("token_market_snapshot_id"), methodologyVersion: text("methodology_version").notNull(), evaluationGeneration: integer("evaluation_generation").default(1).notNull(), evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(), supersededAt: timestamp("superseded_at", { withTimezone: true }), supersessionReason: text("supersession_reason"), createdAt: createdAt(),
}, (table) => [uniqueIndex("wallet_anomaly_identity_uq").on(table.actionId, table.featureKind, table.ruleId, table.methodologyVersion, table.evaluationGeneration), index("wallet_anomaly_wallet_time_idx").on(table.walletId, table.evaluatedAt), index("wallet_anomaly_incident_idx").on(table.incidentId)]);

export const walletAnomalyNotifications = pgTable("wallet_anomaly_notifications", {
  id: id(), incidentId: uuid("incident_id").references(() => walletBehaviorIncidents.id, { onDelete: "cascade" }).notNull(), revision: integer("revision").notNull(), provider: text("provider").notNull(), destinationKey: text("destination_key").notNull(),
  status: text("status").default("PENDING").notNull(), attemptCount: integer("attempt_count").default(0).notNull(), payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), externalId: text("external_id"), lastErrorCode: text("last_error_code"), nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).defaultNow().notNull(), deliveredAt: timestamp("delivered_at", { withTimezone: true }), createdAt: createdAt(),
}, (table) => [uniqueIndex("wallet_anomaly_notification_identity_uq").on(table.incidentId, table.revision, table.provider, table.destinationKey), index("wallet_anomaly_notification_pending_idx").on(table.status, table.nextAttemptAt)]);

export const walletBehaviorState = pgTable("wallet_behavior_state", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).primaryKey(), watermarkOrderingKey: text("watermark_ordering_key"), historyStatus: text("history_status").default("NOT_BUILT").notNull(), historyCursor: text("history_cursor"), historyComplete: boolean("history_complete").default(false).notNull(), dirtyFromOrderingKey: text("dirty_from_ordering_key"), evaluationGeneration: integer("evaluation_generation").default(1).notNull(), methodologyVersion: text("methodology_version").notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Internal-only evaluation ledger. Nothing in the notification pipeline references this table. */
export const walletBehaviorShadowEvaluations = pgTable("wallet_behavior_shadow_evaluations", {
  id: id(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  transactionId: uuid("transaction_id").references(() => walletTransactions.id, { onDelete: "cascade" }).notNull(),
  actionId: uuid("action_id").references(() => walletEconomicActions.id, { onDelete: "cascade" }).notNull(),
  observationId: uuid("observation_id").references(() => walletBehaviorObservations.id, { onDelete: "cascade" }).notNull(),
  baselineId: uuid("baseline_id").references(() => walletBehaviorBaselines.id),
  featureKind: text("feature_kind").notNull(), family: text("family").notNull(),
  status: text("status").notNull(), reasonCode: text("reason_code"), isAnomaly: boolean("is_anomaly").default(false).notNull(),
  severity: text("severity"), direction: text("direction"), deviationBps: integer("deviation_bps"),
  percentileLowerBps: integer("percentile_lower_bps"), percentileUpperBps: integer("percentile_upper_bps"), ruleId: text("rule_id"),
  groupKey: text("group_key").notNull(), evidence: jsonb("evidence").$type<Record<string, unknown>>().default({}).notNull(),
  methodologyVersion: text("methodology_version").notNull(), baselineMethodologyVersion: text("baseline_methodology_version"),
  evaluationGeneration: integer("evaluation_generation").notNull(), evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(), createdAt: createdAt(),
}, (table) => [
  uniqueIndex("wallet_behavior_shadow_evaluation_identity_uq").on(table.observationId, table.methodologyVersion, table.evaluationGeneration),
  index("wallet_behavior_shadow_evaluation_wallet_time_idx").on(table.walletId, table.evaluatedAt),
  index("wallet_behavior_shadow_evaluation_group_idx").on(table.walletId, table.groupKey),
  check("wallet_behavior_shadow_evaluation_status_ck", sql`${table.status} in ('EVALUATED','NON_EVALUABLE')`),
  check("wallet_behavior_shadow_evaluation_severity_ck", sql`${table.severity} is null or ${table.severity} in ('NOTABLE','UNUSUAL','EXTREME')`),
  check("wallet_behavior_shadow_evaluation_direction_ck", sql`${table.direction} is null or ${table.direction} in ('LOW','HIGH','RARE','UNSEEN')`),
  check("wallet_behavior_shadow_evaluation_bps_ck", sql`(${table.deviationBps} is null or ${table.deviationBps} between 0 and 10000) and (${table.percentileLowerBps} is null or ${table.percentileLowerBps} between 0 and 10000) and (${table.percentileUpperBps} is null or ${table.percentileUpperBps} between 0 and 10000) and ${table.evaluationGeneration} >= 1`),
  check("wallet_behavior_shadow_evaluation_state_ck", sql`
    (${table.status} = 'NON_EVALUABLE' and ${table.reasonCode} is not null and ${table.isAnomaly} = false and ${table.severity} is null and ${table.direction} is null and ${table.deviationBps} is null and ${table.percentileLowerBps} is null and ${table.percentileUpperBps} is null and ${table.ruleId} is null)
    or
    (${table.status} = 'EVALUATED' and ${table.baselineId} is not null and ${table.baselineMethodologyVersion} is not null and (
      (${table.reasonCode} = 'NORMAL' and ${table.isAnomaly} = false and ${table.severity} is null and ${table.direction} is null and ${table.deviationBps} is null and ${table.ruleId} is null)
      or
      (${table.reasonCode} = 'ANOMALY' and ${table.isAnomaly} = true and ${table.severity} is not null and ${table.direction} is not null and ${table.deviationBps} is not null and ${table.ruleId} is not null)
    ))`),
]);
