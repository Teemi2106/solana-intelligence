CREATE TABLE "wallet_economic_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"action_index" integer NOT NULL,
	"action" text NOT NULL,
	"token_id" uuid,
	"raw_token_amount" numeric(78, 0),
	"token_decimals" integer,
	"consideration_mint" text,
	"consideration_raw_amount" numeric(78, 0),
	"consideration_decimals" integer,
	"position_before_raw" numeric(78, 0),
	"position_after_raw" numeric(78, 0),
	"position_impact_numerator" numeric(78, 0),
	"position_impact_denominator" numeric(78, 0),
	"confidence" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"provider_type" text NOT NULL,
	"classification_version" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_economic_actions_decimals_range" CHECK ("wallet_economic_actions"."token_decimals" is null or "wallet_economic_actions"."token_decimals" between 0 and 30),
	CONSTRAINT "wallet_economic_actions_consideration_decimals_range" CHECK ("wallet_economic_actions"."consideration_decimals" is null or "wallet_economic_actions"."consideration_decimals" between 0 and 30)
);
--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD CONSTRAINT "wallet_economic_actions_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD CONSTRAINT "wallet_economic_actions_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_economic_actions" ADD CONSTRAINT "wallet_economic_actions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_economic_actions_transaction_index_uq" ON "wallet_economic_actions" USING btree ("transaction_id","action_index");--> statement-breakpoint
CREATE INDEX "wallet_economic_actions_wallet_time_idx" ON "wallet_economic_actions" USING btree ("wallet_id","occurred_at");--> statement-breakpoint
CREATE INDEX "wallet_economic_actions_action_time_idx" ON "wallet_economic_actions" USING btree ("action","occurred_at");