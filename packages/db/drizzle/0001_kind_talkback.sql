CREATE TYPE "public"."basis_source" AS ENUM('PURCHASE', 'TRANSFER_UNKNOWN', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."flow_direction" AS ENUM('IN', 'OUT');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'PAUSED');--> statement-breakpoint
CREATE TYPE "public"."transaction_kind" AS ENUM('SWAP', 'TRANSFER', 'AMBIGUOUS', 'OTHER');--> statement-breakpoint
CREATE TABLE "transaction_token_flows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"direction" "flow_direction" NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"decimals" integer NOT NULL,
	"account" text,
	"counterparty" text,
	"flow_index" integer NOT NULL,
	"is_fee" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transaction_token_flows_decimals_range" CHECK ("transaction_token_flows"."decimals" between 0 and 30)
);
--> statement-breakpoint
CREATE TABLE "wallet_classification_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"classification_id" uuid NOT NULL,
	"transaction_id" uuid,
	"evidence_type" text NOT NULL,
	"confidence_bps" integer NOT NULL,
	"facts" jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_class_evidence_confidence" CHECK ("wallet_classification_evidence"."confidence_bps" between 0 and 10000)
);
--> statement-breakpoint
CREATE TABLE "wallet_ingestion_checkpoints" (
	"wallet_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"cursor" text,
	"oldest_slot" numeric(78, 0),
	"newest_slot" numeric(78, 0),
	"completed" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_ingestion_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"status" "ingestion_status" DEFAULT 'PENDING' NOT NULL,
	"cursor" text,
	"pages_processed" integer DEFAULT 0 NOT NULL,
	"transactions_seen" integer DEFAULT 0 NOT NULL,
	"transactions_stored" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_inventory_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"source_trade_id" uuid,
	"source_transaction_id" uuid NOT NULL,
	"basis_source" "basis_source" NOT NULL,
	"acquired_raw_amount" numeric(78, 0) NOT NULL,
	"remaining_raw_amount" numeric(78, 0) NOT NULL,
	"cost_basis_usd" numeric(38, 18),
	"remaining_cost_basis_usd" numeric(38, 18),
	"acquired_at" timestamp with time zone NOT NULL,
	"quality" "data_quality" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_positions" (
	"wallet_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"known_cost_basis_usd" numeric(38, 18),
	"unknown_basis_raw_amount" numeric(78, 0) DEFAULT '0' NOT NULL,
	"market_value_usd" numeric(38, 18),
	"unrealized_pnl_usd" numeric(38, 18),
	"price_observed_at" timestamp with time zone,
	"quality" "data_quality" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wallet_realizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"sell_trade_id" uuid NOT NULL,
	"lot_id" uuid NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"proceeds_usd" numeric(38, 18),
	"cost_basis_usd" numeric(38, 18),
	"realized_pnl_usd" numeric(38, 18),
	"roi" numeric(20, 10),
	"holding_seconds" integer,
	"quality" "data_quality" NOT NULL,
	"realized_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "signal_wallets" DROP CONSTRAINT "signal_wallets_wallet_classification_id_wallet_classifications_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction_token_flows" ADD CONSTRAINT "transaction_token_flows_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_token_flows" ADD CONSTRAINT "transaction_token_flows_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_classification_evidence" ADD CONSTRAINT "wallet_classification_evidence_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_classification_evidence" ADD CONSTRAINT "wallet_class_evidence_fk" FOREIGN KEY ("classification_id") REFERENCES "public"."wallet_classifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ingestion_checkpoints" ADD CONSTRAINT "wallet_ingestion_checkpoints_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_ingestion_runs" ADD CONSTRAINT "wallet_ingestion_runs_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD CONSTRAINT "wallet_inventory_lots_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD CONSTRAINT "wallet_inventory_lots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD CONSTRAINT "wallet_inventory_lots_source_trade_id_wallet_trades_id_fk" FOREIGN KEY ("source_trade_id") REFERENCES "public"."wallet_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD CONSTRAINT "wallet_inventory_lots_source_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_positions" ADD CONSTRAINT "wallet_positions_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_positions" ADD CONSTRAINT "wallet_positions_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD CONSTRAINT "wallet_realizations_wallet_id_tracked_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."tracked_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD CONSTRAINT "wallet_realizations_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD CONSTRAINT "wallet_realizations_sell_trade_id_wallet_trades_id_fk" FOREIGN KEY ("sell_trade_id") REFERENCES "public"."wallet_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD CONSTRAINT "wallet_realizations_lot_id_wallet_inventory_lots_id_fk" FOREIGN KEY ("lot_id") REFERENCES "public"."wallet_inventory_lots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transaction_token_flows_identity_uq" ON "transaction_token_flows" USING btree ("transaction_id","flow_index");--> statement-breakpoint
CREATE INDEX "transaction_token_flows_token_idx" ON "transaction_token_flows" USING btree ("token_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_class_evidence_identity_uq" ON "wallet_classification_evidence" USING btree ("classification_id","evidence_type","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_ingestion_idempotency_uq" ON "wallet_ingestion_runs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "wallet_ingestion_wallet_status_idx" ON "wallet_ingestion_runs" USING btree ("wallet_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_inventory_source_uq" ON "wallet_inventory_lots" USING btree ("wallet_id","source_transaction_id","token_id");--> statement-breakpoint
CREATE INDEX "wallet_inventory_fifo_idx" ON "wallet_inventory_lots" USING btree ("wallet_id","token_id","acquired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_positions_identity_uq" ON "wallet_positions" USING btree ("wallet_id","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_realization_sell_lot_uq" ON "wallet_realizations" USING btree ("sell_trade_id","lot_id");--> statement-breakpoint
CREATE INDEX "wallet_realization_wallet_time_idx" ON "wallet_realizations" USING btree ("wallet_id","realized_at");--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD CONSTRAINT "sig_wallet_class_fk" FOREIGN KEY ("wallet_classification_id") REFERENCES "public"."wallet_classifications"("id") ON DELETE no action ON UPDATE no action;