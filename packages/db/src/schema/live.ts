import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, slot } from "./common";
import { tokens } from "./chain";
import { trackedWallets } from "./wallets";

/** Observed state of a provider-side live subscription. The database is the desired-state source of truth; this is only a cache of what the provider reported. */
export const providerSubscriptions = pgTable("provider_subscriptions", {
  id: id(),
  provider: text("provider").notNull(),
  kind: text("kind").notNull(),
  externalId: text("external_id"),
  status: text("status").notNull(),
  desiredAddressCount: integer("desired_address_count").default(0).notNull(),
  providerAddressCount: integer("provider_address_count").default(0).notNull(),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [uniqueIndex("provider_subscriptions_identity_uq").on(table.provider, table.kind)]);

export const providerSyncRuns = pgTable("provider_sync_runs", {
  id: id(),
  provider: text("provider").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  outcome: text("outcome").notNull(),
  added: integer("added").default(0).notNull(),
  removed: integer("removed").default(0).notNull(),
  desiredCount: integer("desired_count").default(0).notNull(),
  providerCount: integer("provider_count").default(0).notNull(),
  errorCode: text("error_code"),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
}, (table) => [index("provider_sync_runs_recent_idx").on(table.provider, table.startedAt)]);

export const walletLiveMonitoring = pgTable("wallet_live_monitoring", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).primaryKey(),
  /** When a reconcile last confirmed the provider is watching this wallet. */
  providerConfirmedAt: timestamp("provider_confirmed_at", { withTimezone: true }),
  lastEventAt: timestamp("last_event_at", { withTimezone: true }),
  lastSignature: text("last_signature"),
  lastSlot: slot("last_slot"),
  lastBackfillAt: timestamp("last_backfill_at", { withTimezone: true }),
  lastBackfillStatus: text("last_backfill_status"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/** A history boundary that was reached by a complete recovery scan; observed live slots alone are never verification. */
export const walletRecoveryCheckpoints = pgTable("wallet_recovery_checkpoints", {
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).primaryKey(),
  provider: text("provider").default("helius").notNull(),
  verifiedThroughAt: timestamp("verified_through_at", { withTimezone: true }),
  verifiedThroughSlot: bigint("verified_through_slot", { mode: "bigint" }),
  anchorSignature: text("anchor_signature"),
  lastScanStartedAt: timestamp("last_scan_started_at", { withTimezone: true }),
  lastScanCompletedAt: timestamp("last_scan_completed_at", { withTimezone: true }),
  lastScanStatus: text("last_scan_status"),
  lastScanPages: integer("last_scan_pages").default(0).notNull(),
  lastScanTransactionsSeen: integer("last_scan_transactions_seen").default(0).notNull(),
  lastScanTransactionsCreated: integer("last_scan_transactions_created").default(0).notNull(),
  consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
  nextIntegrityCheckAt: timestamp("next_integrity_check_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("wallet_recovery_integrity_due_idx").on(table.nextIntegrityCheckAt)]);

/** Durable reason and time range for recovery; overlapping triggers can share one window instead of queue fan-out. */
export const liveRecoveryWindows = pgTable("live_recovery_windows", {
  id: id(),
  provider: text("provider").default("helius").notNull(),
  scope: text("scope").notNull(),
  reason: text("reason").notNull(),
  unhealthyFrom: timestamp("unhealthy_from", { withTimezone: true }).notNull(),
  healthyAt: timestamp("healthy_at", { withTimezone: true }),
  status: text("status").notNull(),
  shadow: text("shadow").default("true").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("live_recovery_windows_status_idx").on(table.status, table.createdAt)]);

/** Per-wallet durable work/result inside a recovery window. Redis is only a wake-up mechanism. */
export const liveRecoveryTasks = pgTable("live_recovery_tasks", {
  id: id(),
  windowId: uuid("window_id").references(() => liveRecoveryWindows.id, { onDelete: "cascade" }).notNull(),
  walletId: uuid("wallet_id").references(() => trackedWallets.id, { onDelete: "cascade" }).notNull(),
  status: text("status").notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  pages: integer("pages").default(0).notNull(),
  transactionsSeen: integer("transactions_seen").default(0).notNull(),
  transactionsCreated: integer("transactions_created").default(0).notNull(),
  lastErrorCode: text("last_error_code"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("live_recovery_tasks_window_wallet_uq").on(table.windowId, table.walletId),
  index("live_recovery_tasks_status_idx").on(table.status, table.createdAt),
  index("live_recovery_tasks_wallet_idx").on(table.walletId, table.createdAt),
]);

/** Facts about a token's first on-chain activity, used only for neutral timing evidence. */
export const tokenLaunchFacts = pgTable("token_launch_facts", {
  tokenId: uuid("token_id").references(() => tokens.id, { onDelete: "cascade" }).primaryKey(),
  status: text("status").notNull(),
  firstActivityAt: timestamp("first_activity_at", { withTimezone: true }),
  firstActivitySlot: slot("first_activity_slot"),
  firstSignature: text("first_signature"),
  /** Fee payer / first signer of the mint's earliest transaction. Not a claim about who controls the token. */
  firstSigner: text("first_signer"),
  source: text("source").notNull(),
  errorCode: text("error_code"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});
