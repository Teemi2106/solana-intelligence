CREATE TABLE "live_recovery_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"window_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"pages" integer DEFAULT 0 NOT NULL,
	"transactions_seen" integer DEFAULT 0 NOT NULL,
	"transactions_created" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "live_recovery_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text DEFAULT 'helius' NOT NULL,
	"scope" text NOT NULL,
	"reason" text NOT NULL,
	"unhealthy_from" timestamp with time zone NOT NULL,
	"healthy_at" timestamp with time zone,
	"status" text NOT NULL,
	"shadow" text DEFAULT 'true' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_recovery_checkpoints" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'helius' NOT NULL,
	"verified_through_at" timestamp with time zone,
	"verified_through_slot" bigint,
	"anchor_signature" text,
	"last_scan_started_at" timestamp with time zone,
	"last_scan_completed_at" timestamp with time zone,
	"last_scan_status" text,
	"last_scan_pages" integer DEFAULT 0 NOT NULL,
	"last_scan_transactions_seen" integer DEFAULT 0 NOT NULL,
	"last_scan_transactions_created" integer DEFAULT 0 NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"next_integrity_check_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_recovery_tasks" ADD CONSTRAINT "live_recovery_tasks_window_id_live_recovery_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."live_recovery_windows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_recovery_tasks" ADD CONSTRAINT "live_recovery_tasks_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_recovery_checkpoints" ADD CONSTRAINT "wallet_recovery_checkpoints_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "live_recovery_tasks_window_wallet_uq" ON "live_recovery_tasks" USING btree ("window_id","wallet_id");--> statement-breakpoint
CREATE INDEX "live_recovery_tasks_status_idx" ON "live_recovery_tasks" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "live_recovery_tasks_wallet_idx" ON "live_recovery_tasks" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "live_recovery_windows_status_idx" ON "live_recovery_windows" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "wallet_recovery_integrity_due_idx" ON "wallet_recovery_checkpoints" USING btree ("next_integrity_check_at");