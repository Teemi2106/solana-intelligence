CREATE TABLE "provider_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text,
	"status" text NOT NULL,
	"desired_address_count" integer DEFAULT 0 NOT NULL,
	"provider_address_count" integer DEFAULT 0 NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_sync_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text NOT NULL,
	"added" integer DEFAULT 0 NOT NULL,
	"removed" integer DEFAULT 0 NOT NULL,
	"desired_count" integer DEFAULT 0 NOT NULL,
	"provider_count" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_launch_facts" (
	"token_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"first_activity_at" timestamp with time zone,
	"first_activity_slot" bigint,
	"first_signature" text,
	"first_signer" text,
	"source" text NOT NULL,
	"error_code" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_live_monitoring" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"provider_confirmed_at" timestamp with time zone,
	"last_event_at" timestamp with time zone,
	"last_signature" text,
	"last_slot" bigint,
	"last_backfill_at" timestamp with time zone,
	"last_backfill_status" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_events" ADD COLUMN "payload" jsonb;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "ingestion_source" text DEFAULT 'helius-history' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "first_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "finalized_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_transactions" ADD COLUMN "finality_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "token_launch_facts" ADD CONSTRAINT "token_launch_facts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_live_monitoring" ADD CONSTRAINT "wallet_live_monitoring_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_subscriptions_identity_uq" ON "provider_subscriptions" USING btree ("provider","kind");--> statement-breakpoint
CREATE INDEX "provider_sync_runs_recent_idx" ON "provider_sync_runs" USING btree ("provider","started_at");--> statement-breakpoint
CREATE INDEX "wallet_transactions_finality_idx" ON "wallet_transactions" USING btree ("finality","first_seen_at");