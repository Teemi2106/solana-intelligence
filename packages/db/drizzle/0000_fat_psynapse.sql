CREATE TYPE "public"."alert_level" AS ENUM('INFO', 'WATCH', 'HIGH', 'CRITICAL');--> statement-breakpoint
CREATE TYPE "public"."data_quality" AS ENUM('HIGH', 'MEDIUM', 'LOW', 'INSUFFICIENT');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('PENDING', 'DELIVERED', 'RETRYING', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."processing_status" AS ENUM('RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."relationship_type" AS ENUM('FUNDED_BY', 'FUNDED', 'TOKEN_RECEIVED_FROM', 'DEPLOYER_TRANSFER', 'REPEATED_COUNTERPARTY', 'POSSIBLY_RELATED', 'COMMON_FUNDING_SOURCE');--> statement-breakpoint
CREATE TYPE "public"."signal_type" AS ENUM('SMART_MONEY_CONVERGENCE', 'EARLY_MOVEMENT', 'EARLY_MOVEMENT_WITH_PUBLIC_CONFIRMATION');--> statement-breakpoint
CREATE TYPE "public"."trade_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TYPE "public"."wallet_classification" AS ENUM('COPYABLE_SMART_MONEY', 'EARLY_ACCESS_ALLOCATION_PATTERN', 'RELATED_TEAM_LINKED', 'UNKNOWN_INSUFFICIENT_EVIDENCE');--> statement-breakpoint
CREATE TYPE "public"."wallet_status" AS ENUM('ACTIVE', 'PAUSED', 'ARCHIVED');--> statement-breakpoint
CREATE TABLE "provider_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"external_event_id" text NOT NULL,
	"payload_hash" text NOT NULL,
	"event_type" text NOT NULL,
	"status" "processing_status" DEFAULT 'RECEIVED' NOT NULL,
	"signature" text,
	"slot" bigint,
	"occurred_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"payload_summary" jsonb NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error_code" text
);
--> statement-breakpoint
CREATE TABLE "token_market_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"price_usd" numeric(38, 18),
	"market_cap_usd" numeric(38, 18),
	"fdv_usd" numeric(38, 18),
	"liquidity_usd" numeric(38, 18),
	"volume_24h_usd" numeric(38, 18),
	"holder_count" integer,
	"quality" "data_quality" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_risk_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"score" integer NOT NULL,
	"score_version" text NOT NULL,
	"indicators" jsonb NOT NULL,
	"top_10_concentration_bps" integer,
	"creator_concentration_bps" integer,
	"mint_authority_enabled" boolean,
	"freeze_authority_enabled" boolean,
	"quality" "data_quality" NOT NULL,
	CONSTRAINT "token_risk_score_range" CHECK ("token_risk_snapshots"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mint" text NOT NULL,
	"decimals" integer,
	"symbol" text,
	"name" text,
	"created_on_chain_at" timestamp with time zone,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_trades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"side" "trade_side" NOT NULL,
	"raw_token_amount" numeric(78, 0) NOT NULL,
	"token_decimals" integer NOT NULL,
	"raw_base_amount" numeric(78, 0),
	"base_decimals" integer,
	"base_mint" text,
	"estimated_usd_value" numeric(38, 18),
	"fee_usd" numeric(38, 18),
	"execution_price_usd" numeric(38, 18),
	"quality" "data_quality" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_trades_decimals_range" CHECK ("wallet_trades"."token_decimals" between 0 and 30)
);
--> statement-breakpoint
CREATE TABLE "wallet_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"provider_event_id" uuid NOT NULL,
	"signature" text NOT NULL,
	"instruction_index" integer NOT NULL,
	"inner_instruction_index" integer DEFAULT -1 NOT NULL,
	"kind" text NOT NULL,
	"slot" bigint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"finality" text NOT NULL,
	"succeeded" boolean NOT NULL,
	"normalized_payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"alert_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"destination_key" text NOT NULL,
	"status" "delivery_status" DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"external_id" text,
	"last_error_code" text,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"level" "alert_level" NOT NULL,
	"deduplication_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"notification_price_usd" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"horizon_seconds" integer NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"measured_at" timestamp with time zone,
	"price_usd" numeric(38, 18),
	"return_from_detection" numeric(20, 10),
	"return_from_notification" numeric(20, 10),
	"maximum_favorable_excursion" numeric(20, 10),
	"maximum_adverse_excursion" numeric(20, 10),
	"peak_price_usd" numeric(38, 18),
	"lowest_price_usd" numeric(38, 18),
	"time_to_peak_seconds" integer,
	"liquidity_usd" numeric(38, 18),
	"quality" "data_quality" NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
CREATE TABLE "signal_score_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"formula" jsonb NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signal_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_wallets" (
	"signal_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"wallet_score_id" uuid,
	"wallet_classification_id" uuid,
	"independence_cluster" text NOT NULL,
	"independence_weight" numeric(20, 10) NOT NULL,
	"role" text NOT NULL,
	"purchase_value_usd" numeric(38, 18),
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signal_wallets_signal_id_wallet_id_role_pk" PRIMARY KEY("signal_id","wallet_id","role")
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"type" "signal_type" NOT NULL,
	"level" "alert_level" NOT NULL,
	"score" integer NOT NULL,
	"score_version_id" uuid NOT NULL,
	"component_scores" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"explanation" jsonb NOT NULL,
	"detection_price_usd" numeric(38, 18),
	"detection_market_cap_usd" numeric(38, 18),
	"detection_liquidity_usd" numeric(38, 18),
	"market_snapshot_id" uuid,
	"risk_snapshot_id" uuid,
	"raw_wallet_count" integer NOT NULL,
	"independent_cluster_count" integer NOT NULL,
	"independence_weight" numeric(20, 10) NOT NULL,
	"detected_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signals_score_range" CHECK ("signals"."score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"request_id" text NOT NULL,
	"ip_hash" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processing_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" uuid,
	"queue" text NOT NULL,
	"job_id" text NOT NULL,
	"error_code" text NOT NULL,
	"error_message" text NOT NULL,
	"safe_context" jsonb NOT NULL,
	"attempt_count" integer NOT NULL,
	"failed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "schema_migrations" (
	"name" text PRIMARY KEY NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_health" (
	"component" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"status" text NOT NULL,
	"details" jsonb NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracked_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" text NOT NULL,
	"status" "wallet_status" DEFAULT 'ACTIVE' NOT NULL,
	"display_name" text,
	"monitoring_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_classifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"classification" "wallet_classification" NOT NULL,
	"early_access_score" integer,
	"confidence_bps" integer NOT NULL,
	"evidence" jsonb,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_classifications_confidence_range" CHECK ("wallet_classifications"."confidence_bps" between 0 and 10000),
	CONSTRAINT "wallet_classifications_early_score_range" CHECK ("wallet_classifications"."early_access_score" is null or "wallet_classifications"."early_access_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "wallet_labels" (
	"wallet_id" uuid NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_labels_wallet_id_label_source_pk" PRIMARY KEY("wallet_id","label","source")
);
--> statement-breakpoint
CREATE TABLE "wallet_performance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"window_days" integer NOT NULL,
	"realized_pnl_usd" numeric(38, 18),
	"unrealized_pnl_usd" numeric(38, 18),
	"completed_trades" integer NOT NULL,
	"profitable_trades" integer NOT NULL,
	"losing_trades" integer NOT NULL,
	"median_roi" numeric(20, 10),
	"average_roi" numeric(20, 10),
	"largest_winner_usd" numeric(38, 18),
	"largest_loser_usd" numeric(38, 18),
	"profit_excluding_largest_usd" numeric(38, 18),
	"largest_trade_contribution" numeric(20, 10),
	"metrics" jsonb NOT NULL,
	"quality" "data_quality" NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_address" text NOT NULL,
	"target_address" text NOT NULL,
	"type" "relationship_type" NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"observation_count" integer DEFAULT 1 NOT NULL,
	"confidence_bps" integer NOT NULL,
	"evidence" jsonb,
	CONSTRAINT "wallet_relationship_confidence_range" CHECK ("wallet_relationships"."confidence_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "wallet_score_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"formula" jsonb NOT NULL,
	"activated_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"score_version_id" uuid NOT NULL,
	"value" integer NOT NULL,
	"component_scores" jsonb NOT NULL,
	"inputs" jsonb NOT NULL,
	"quality" "data_quality" NOT NULL,
	"valid_from" timestamp with time zone NOT NULL,
	"valid_to" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_scores_value_range" CHECK ("wallet_scores"."value" between 0 and 100)
);
--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD CONSTRAINT "token_market_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_provider_event_id_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_snapshots" ADD CONSTRAINT "signal_snapshots_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD CONSTRAINT "signal_wallets_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD CONSTRAINT "signal_wallets_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD CONSTRAINT "signal_wallets_wallet_score_id_wallet_scores_id_fk" FOREIGN KEY ("wallet_score_id") REFERENCES "public"."wallet_scores"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD CONSTRAINT "signal_wallets_wallet_classification_id_wallet_classifications_id_fk" FOREIGN KEY ("wallet_classification_id") REFERENCES "public"."wallet_classifications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_score_version_id_signal_score_versions_id_fk" FOREIGN KEY ("score_version_id") REFERENCES "public"."signal_score_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_market_snapshot_id_token_market_snapshots_id_fk" FOREIGN KEY ("market_snapshot_id") REFERENCES "public"."token_market_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_risk_snapshot_id_token_risk_snapshots_id_fk" FOREIGN KEY ("risk_snapshot_id") REFERENCES "public"."token_risk_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "processing_failures" ADD CONSTRAINT "processing_failures_provider_event_id_provider_events_id_fk" FOREIGN KEY ("provider_event_id") REFERENCES "public"."provider_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_classifications" ADD CONSTRAINT "wallet_classifications_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_labels" ADD CONSTRAINT "wallet_labels_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_performance_snapshots" ADD CONSTRAINT "wallet_performance_snapshots_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_scores" ADD CONSTRAINT "wallet_scores_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_scores" ADD CONSTRAINT "wallet_scores_score_version_id_wallet_score_versions_id_fk" FOREIGN KEY ("score_version_id") REFERENCES "public"."wallet_score_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_events_identity_uq" ON "provider_events" USING btree ("provider","external_event_id");--> statement-breakpoint
CREATE INDEX "provider_events_status_received_idx" ON "provider_events" USING btree ("status","received_at");--> statement-breakpoint
CREATE INDEX "provider_events_signature_idx" ON "provider_events" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "token_market_observation_uq" ON "token_market_snapshots" USING btree ("token_id","provider","observed_at");--> statement-breakpoint
CREATE INDEX "token_market_recent_idx" ON "token_market_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE INDEX "token_risk_recent_idx" ON "token_risk_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tokens_mint_uq" ON "tokens" USING btree ("mint");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_trades_transaction_token_side_uq" ON "wallet_trades" USING btree ("transaction_id","token_id","side");--> statement-breakpoint
CREATE INDEX "wallet_trades_wallet_token_time_idx" ON "wallet_trades" USING btree ("wallet_id","token_id","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_trades_token_side_time_idx" ON "wallet_trades" USING btree ("token_id","side","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_transactions_identity_uq" ON "wallet_transactions" USING btree ("wallet_id","signature","instruction_index","inner_instruction_index");--> statement-breakpoint
CREATE INDEX "wallet_transactions_wallet_time_idx" ON "wallet_transactions" USING btree ("wallet_id","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_signature_idx" ON "wallet_transactions" USING btree ("signature");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_deliveries_destination_uq" ON "alert_deliveries" USING btree ("alert_id","provider","destination_key");--> statement-breakpoint
CREATE INDEX "alert_deliveries_pending_idx" ON "alert_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_deduplication_key_uq" ON "alerts" USING btree ("deduplication_key");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_outcomes_horizon_uq" ON "signal_outcomes" USING btree ("signal_id","horizon_seconds");--> statement-breakpoint
CREATE INDEX "signal_outcomes_pending_idx" ON "signal_outcomes" USING btree ("due_at","measured_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_score_versions_version_uq" ON "signal_score_versions" USING btree ("version");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_snapshots_kind_time_uq" ON "signal_snapshots" USING btree ("signal_id","kind","observed_at");--> statement-breakpoint
CREATE INDEX "signals_recent_idx" ON "signals" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "signals_token_time_idx" ON "signals" USING btree ("token_id","detected_at");--> statement-breakpoint
CREATE INDEX "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processing_failures_job_uq" ON "processing_failures" USING btree ("queue","job_id");--> statement-breakpoint
CREATE INDEX "processing_failures_unresolved_idx" ON "processing_failures" USING btree ("resolved_at","failed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tracked_wallets_address_uq" ON "tracked_wallets" USING btree ("address");--> statement-breakpoint
CREATE INDEX "tracked_wallets_status_idx" ON "tracked_wallets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "wallet_classifications_as_of_idx" ON "wallet_classifications" USING btree ("wallet_id","valid_from","valid_to");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_performance_observation_uq" ON "wallet_performance_snapshots" USING btree ("wallet_id","window_days","observed_at");--> statement-breakpoint
CREATE INDEX "wallet_performance_recent_idx" ON "wallet_performance_snapshots" USING btree ("wallet_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_relationship_identity_uq" ON "wallet_relationships" USING btree ("source_address","target_address","type");--> statement-breakpoint
CREATE INDEX "wallet_relationship_target_idx" ON "wallet_relationships" USING btree ("target_address","type");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_score_versions_version_uq" ON "wallet_score_versions" USING btree ("version");--> statement-breakpoint
CREATE INDEX "wallet_scores_as_of_idx" ON "wallet_scores" USING btree ("wallet_id","valid_from","valid_to");