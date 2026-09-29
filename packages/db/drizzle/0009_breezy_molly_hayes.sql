CREATE TABLE "wallet_anomalies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"incident_id" uuid,
	"baseline_id" uuid,
	"feature_kind" text NOT NULL,
	"family" text NOT NULL,
	"observed" jsonb NOT NULL,
	"percentile_lower_bps" integer,
	"percentile_upper_bps" integer,
	"baseline_quality" text NOT NULL,
	"severity_contribution" text NOT NULL,
	"rule_id" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"token_market_snapshot_id" uuid,
	"methodology_version" text NOT NULL,
	"evaluation_generation" integer DEFAULT 1 NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"supersession_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_anomaly_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"provider" text NOT NULL,
	"destination_key" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"payload" jsonb NOT NULL,
	"external_id" text,
	"last_error_code" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_behavior_baselines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"feature_kind" text NOT NULL,
	"cohort" text DEFAULT 'ALL' NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"through_ordering_key" text NOT NULL,
	"observation_count" integer NOT NULL,
	"coverage_days" integer NOT NULL,
	"quality" text NOT NULL,
	"history_complete" boolean NOT NULL,
	"completeness_bps" integer,
	"statistics" jsonb NOT NULL,
	"methodology_version" text NOT NULL,
	"evaluation_generation" integer DEFAULT 1 NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_behavior_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"anchor_action_id" uuid NOT NULL,
	"first_ordering_key" text NOT NULL,
	"latest_ordering_key" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"latest_at" timestamp with time zone NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"rule_ids" jsonb NOT NULL,
	"families" jsonb NOT NULL,
	"baseline_quality" text NOT NULL,
	"methodology_version" text NOT NULL,
	"evaluation_generation" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_behavior_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid,
	"action_id" uuid,
	"token_id" uuid,
	"source_type" text NOT NULL,
	"source_id" text NOT NULL,
	"feature_kind" text NOT NULL,
	"family" text NOT NULL,
	"numeric_value" numeric(78, 18),
	"categorical_value" text,
	"unit" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"ordering_key" text NOT NULL,
	"quality" text NOT NULL,
	"methodology_version" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"included_in_baseline" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_behavior_observation_one_value" CHECK (("wallet_behavior_observations"."numeric_value" is null) <> ("wallet_behavior_observations"."categorical_value" is null))
);
--> statement-breakpoint
CREATE TABLE "wallet_behavior_state" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"watermark_ordering_key" text,
	"history_status" text DEFAULT 'NOT_BUILT' NOT NULL,
	"history_cursor" text,
	"history_complete" boolean DEFAULT false NOT NULL,
	"dirty_from_ordering_key" text,
	"evaluation_generation" integer DEFAULT 1 NOT NULL,
	"methodology_version" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD COLUMN "native_destination" text;--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD COLUMN "native_pre_balance_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD COLUMN "native_post_balance_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD COLUMN "native_transfer_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD COLUMN "native_fee_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_anomalies" ADD CONSTRAINT "wallet_anomalies_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_anomalies" ADD CONSTRAINT "wallet_anomalies_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_anomalies" ADD CONSTRAINT "wallet_anomalies_action_id_wallet_economic_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."wallet_economic_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_anomalies" ADD CONSTRAINT "wallet_anomalies_incident_id_wallet_behavior_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."wallet_behavior_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_anomalies" ADD CONSTRAINT "wallet_anomalies_baseline_id_wallet_behavior_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."wallet_behavior_baselines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_anomaly_notifications" ADD CONSTRAINT "wallet_anomaly_notifications_incident_id_wallet_behavior_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."wallet_behavior_incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_baselines" ADD CONSTRAINT "wallet_behavior_baselines_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_incidents" ADD CONSTRAINT "wallet_behavior_incidents_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_incidents" ADD CONSTRAINT "wallet_behavior_incidents_anchor_action_id_wallet_economic_actions_id_fk" FOREIGN KEY ("anchor_action_id") REFERENCES "public"."wallet_economic_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_action_id_wallet_economic_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."wallet_economic_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_state" ADD CONSTRAINT "wallet_behavior_state_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_anomaly_identity_uq" ON "wallet_anomalies" USING btree ("action_id","feature_kind","rule_id","methodology_version","evaluation_generation");--> statement-breakpoint
CREATE INDEX "wallet_anomaly_wallet_time_idx" ON "wallet_anomalies" USING btree ("wallet_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "wallet_anomaly_incident_idx" ON "wallet_anomalies" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_anomaly_notification_identity_uq" ON "wallet_anomaly_notifications" USING btree ("incident_id","revision","provider","destination_key");--> statement-breakpoint
CREATE INDEX "wallet_anomaly_notification_pending_idx" ON "wallet_anomaly_notifications" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_behavior_baseline_identity_uq" ON "wallet_behavior_baselines" USING btree ("wallet_id","feature_kind","cohort","through_ordering_key","methodology_version","evaluation_generation");--> statement-breakpoint
CREATE INDEX "wallet_behavior_baseline_latest_idx" ON "wallet_behavior_baselines" USING btree ("wallet_id","feature_kind","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_behavior_incident_anchor_uq" ON "wallet_behavior_incidents" USING btree ("anchor_action_id","methodology_version","evaluation_generation");--> statement-breakpoint
CREATE INDEX "wallet_behavior_incident_wallet_time_idx" ON "wallet_behavior_incidents" USING btree ("wallet_id","latest_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_behavior_observation_identity_uq" ON "wallet_behavior_observations" USING btree ("source_type","source_id","feature_kind","methodology_version");--> statement-breakpoint
CREATE INDEX "wallet_behavior_observation_feature_time_idx" ON "wallet_behavior_observations" USING btree ("wallet_id","feature_kind","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_behavior_observation_order_idx" ON "wallet_behavior_observations" USING btree ("wallet_id","ordering_key");