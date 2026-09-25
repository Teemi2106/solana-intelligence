import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id } from "./common";
import { providerEvents } from "./chain";

export const processingFailures = pgTable("processing_failures", {
  id: id(),
  providerEventId: uuid("provider_event_id").references(() => providerEvents.id),
  queue: text("queue").notNull(),
  jobId: text("job_id").notNull(),
  errorCode: text("error_code").notNull(),
  errorMessage: text("error_message").notNull(),
  safeContext: jsonb("safe_context").$type<Record<string, unknown>>().notNull(),
  attemptCount: integer("attempt_count").notNull(),
  failedAt: timestamp("failed_at", { withTimezone: true }).defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [uniqueIndex("processing_failures_job_uq").on(table.queue, table.jobId), index("processing_failures_unresolved_idx").on(table.resolvedAt, table.failedAt)]);

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id"),
  requestId: text("request_id").notNull(),
  ipHash: text("ip_hash"),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (table) => [index("audit_logs_target_idx").on(table.targetType, table.targetId, table.createdAt), index("audit_logs_actor_idx").on(table.actorId, table.createdAt)]);

export const systemHealth = pgTable("system_health", {
  component: text("component").primaryKey(),
  instanceId: text("instance_id").notNull(),
  status: text("status").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>().notNull(),
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull(),
});

export const schemaMigrations = pgTable("schema_migrations", {
  name: text("name").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).defaultNow().notNull(),
});
