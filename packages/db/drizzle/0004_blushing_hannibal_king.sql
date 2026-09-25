CREATE TYPE "public"."price_observation_status" AS ENUM('FOUND', 'NOT_AVAILABLE', 'UNSUPPORTED');--> statement-breakpoint
CREATE TYPE "public"."pricing_state" AS ENUM('RECONSTRUCTED_UNPRICED', 'PRICED_FROM_STABLECOIN_FLOW', 'PRICED_FROM_SOL_FLOW', 'PRICED_FROM_EXTERNAL_HISTORY', 'MISSING_QUOTE_USD_PRICE', 'MISSING_HISTORICAL_PRICE', 'AMBIGUOUS_CONSIDERATION');--> statement-breakpoint
CREATE TYPE "public"."valuation_basis" AS ENUM('EXACT', 'DERIVED', 'EXTERNAL', 'UNAVAILABLE');--> statement-breakpoint
CREATE TABLE "historical_price_points" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"asset_mint" text NOT NULL,
	"granularity_seconds" integer NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"status" "price_observation_status" NOT NULL,
	"price_usd" numeric(38, 18),
	"observed_at" timestamp with time zone,
	"confidence_bps" integer,
	"reason" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "spent_mint" text;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "spent_raw_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "spent_decimals" integer;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "received_mint" text;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "received_raw_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "received_decimals" integer;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "execution_price_quote" numeric(60, 30);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "consideration_basis" text;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "pricing_state" "pricing_state" DEFAULT 'RECONSTRUCTED_UNPRICED' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "valuation_basis" "valuation_basis" DEFAULT 'UNAVAILABLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "pricing_source" text;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "pricing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "pricing_confidence_bps" integer;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "quote_usd_price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "price_observation_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "pricing_issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "fee_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "network_fee_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "tip_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "rent_excluded_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "unattributed_lamports" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "wsol_normalized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "routed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "route_assets" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD COLUMN "venue" text;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD COLUMN "confidence_bps" integer;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD COLUMN "confidence_bps" integer;--> statement-breakpoint
ALTER TABLE "wallet_realizations" ADD COLUMN "issues" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "historical_price_identity_uq" ON "historical_price_points" USING btree ("provider","asset_mint","granularity_seconds","bucket_start");--> statement-breakpoint
CREATE INDEX "historical_price_asset_time_idx" ON "historical_price_points" USING btree ("asset_mint","bucket_start");--> statement-breakpoint
ALTER TABLE "wallet_trades" ADD CONSTRAINT "wallet_trades_price_observation_id_historical_price_points_id_fk" FOREIGN KEY ("price_observation_id") REFERENCES "public"."historical_price_points"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_trades_pricing_state_idx" ON "wallet_trades" USING btree ("wallet_id","pricing_state");