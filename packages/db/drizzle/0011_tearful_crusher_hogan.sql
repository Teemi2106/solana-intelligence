CREATE TABLE "wallet_behavior_shadow_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"observation_id" uuid NOT NULL,
	"baseline_id" uuid,
	"feature_kind" text NOT NULL,
	"family" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"is_anomaly" boolean DEFAULT false NOT NULL,
	"severity" text,
	"direction" text,
	"deviation_bps" integer,
	"percentile_lower_bps" integer,
	"percentile_upper_bps" integer,
	"rule_id" text,
	"group_key" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"methodology_version" text NOT NULL,
	"baseline_methodology_version" text,
	"evaluation_generation" integer NOT NULL,
	"evaluated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_behavior_shadow_evaluation_status_ck" CHECK ("wallet_behavior_shadow_evaluations"."status" in ('EVALUATED','NON_EVALUABLE')),
	CONSTRAINT "wallet_behavior_shadow_evaluation_severity_ck" CHECK ("wallet_behavior_shadow_evaluations"."severity" is null or "wallet_behavior_shadow_evaluations"."severity" in ('NOTABLE','UNUSUAL','EXTREME')),
	CONSTRAINT "wallet_behavior_shadow_evaluation_direction_ck" CHECK ("wallet_behavior_shadow_evaluations"."direction" is null or "wallet_behavior_shadow_evaluations"."direction" in ('LOW','HIGH','RARE','UNSEEN')),
	CONSTRAINT "wallet_behavior_shadow_evaluation_bps_ck" CHECK (("wallet_behavior_shadow_evaluations"."deviation_bps" is null or "wallet_behavior_shadow_evaluations"."deviation_bps" between 0 and 10000) and ("wallet_behavior_shadow_evaluations"."percentile_lower_bps" is null or "wallet_behavior_shadow_evaluations"."percentile_lower_bps" between 0 and 10000) and ("wallet_behavior_shadow_evaluations"."percentile_upper_bps" is null or "wallet_behavior_shadow_evaluations"."percentile_upper_bps" between 0 and 10000) and "wallet_behavior_shadow_evaluations"."evaluation_generation" >= 1),
	CONSTRAINT "wallet_behavior_shadow_evaluation_state_ck" CHECK (
    ("wallet_behavior_shadow_evaluations"."status" = 'NON_EVALUABLE' and "wallet_behavior_shadow_evaluations"."reason_code" is not null and "wallet_behavior_shadow_evaluations"."is_anomaly" = false and "wallet_behavior_shadow_evaluations"."severity" is null and "wallet_behavior_shadow_evaluations"."direction" is null and "wallet_behavior_shadow_evaluations"."deviation_bps" is null and "wallet_behavior_shadow_evaluations"."percentile_lower_bps" is null and "wallet_behavior_shadow_evaluations"."percentile_upper_bps" is null and "wallet_behavior_shadow_evaluations"."rule_id" is null)
    or
    ("wallet_behavior_shadow_evaluations"."status" = 'EVALUATED' and "wallet_behavior_shadow_evaluations"."baseline_id" is not null and "wallet_behavior_shadow_evaluations"."baseline_methodology_version" is not null and (
      ("wallet_behavior_shadow_evaluations"."reason_code" = 'NORMAL' and "wallet_behavior_shadow_evaluations"."is_anomaly" = false and "wallet_behavior_shadow_evaluations"."severity" is null and "wallet_behavior_shadow_evaluations"."direction" is null and "wallet_behavior_shadow_evaluations"."deviation_bps" is null and "wallet_behavior_shadow_evaluations"."rule_id" is null)
      or
      ("wallet_behavior_shadow_evaluations"."reason_code" = 'ANOMALY' and "wallet_behavior_shadow_evaluations"."is_anomaly" = true and "wallet_behavior_shadow_evaluations"."severity" is not null and "wallet_behavior_shadow_evaluations"."direction" is not null and "wallet_behavior_shadow_evaluations"."deviation_bps" is not null and "wallet_behavior_shadow_evaluations"."rule_id" is not null)
    )))
);
--> statement-breakpoint
ALTER TABLE "wallet_behavior_shadow_evaluations" ADD CONSTRAINT "wallet_behavior_shadow_evaluations_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_shadow_evaluations" ADD CONSTRAINT "wallet_behavior_shadow_evaluations_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_shadow_evaluations" ADD CONSTRAINT "wallet_behavior_shadow_evaluations_action_id_wallet_economic_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."wallet_economic_actions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_shadow_evaluations" ADD CONSTRAINT "wallet_behavior_shadow_evaluations_observation_id_wallet_behavior_observations_id_fk" FOREIGN KEY ("observation_id") REFERENCES "public"."wallet_behavior_observations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_shadow_evaluations" ADD CONSTRAINT "wallet_behavior_shadow_evaluations_baseline_id_wallet_behavior_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."wallet_behavior_baselines"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_behavior_shadow_evaluation_identity_uq" ON "wallet_behavior_shadow_evaluations" USING btree ("observation_id","methodology_version","evaluation_generation");--> statement-breakpoint
CREATE INDEX "wallet_behavior_shadow_evaluation_wallet_time_idx" ON "wallet_behavior_shadow_evaluations" USING btree ("wallet_id","evaluated_at");--> statement-breakpoint
CREATE INDEX "wallet_behavior_shadow_evaluation_group_idx" ON "wallet_behavior_shadow_evaluations" USING btree ("wallet_id","group_key");