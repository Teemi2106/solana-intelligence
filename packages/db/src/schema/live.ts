import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
