CREATE TABLE "token_discovery_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"transaction_succeeded" boolean NOT NULL,
	"observed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_enrichment_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"tier" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_components" jsonb NOT NULL,
	"freshness_bucket" timestamp with time zone NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_until" timestamp with time zone,
	"lease_owner" text,
	"last_error_code" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_holder_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"fresh_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"methodology_version" text NOT NULL,
	"raw_supply" numeric(78, 0),
	"enumerated_raw_amount" numeric(78, 0),
	"enumerated_owner_count" integer DEFAULT 0 NOT NULL,
	"source_account_limit" integer NOT NULL,
	"enumeration_complete" boolean DEFAULT false NOT NULL,
	"supply_coverage_bps" integer,
	"top_1_concentration_bps" integer,
	"top_5_concentration_bps" integer,
	"top_10_concentration_bps" integer,
	"unavailable_fields" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_holder_top_owners" (
	"holder_snapshot_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"owner" text NOT NULL,
	"raw_amount" numeric(78, 0) NOT NULL,
	"token_account_count" integer NOT NULL,
	"classification" text NOT NULL,
	"classification_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_identity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"metadata_fresh_until" timestamp with time zone NOT NULL,
	"authorities_fresh_until" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"methodology_version" text NOT NULL,
	"token_program" text,
	"decimals" integer,
	"raw_supply" numeric(78, 0),
	"mint_authority_status" text NOT NULL,
	"mint_authority" text,
	"freeze_authority_status" text NOT NULL,
	"freeze_authority" text,
	"metadata_status" text NOT NULL,
	"name" text,
	"symbol" text,
	"metadata_uri" text,
	"chain_slot" bigint,
	"unavailable_fields" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_pool_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"market_snapshot_id" uuid NOT NULL,
	"pool_address" text NOT NULL,
	"dex" text NOT NULL,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"base_mint" text NOT NULL,
	"quote_mint" text NOT NULL,
	"price_usd" numeric(38, 18),
	"price_native" numeric(60, 30),
	"liquidity_usd" numeric(38, 18),
	"base_liquidity" numeric(60, 30),
	"quote_liquidity" numeric(60, 30),
	"volume_h1_usd" numeric(38, 18),
	"volume_h6_usd" numeric(38, 18),
	"volume_h24_usd" numeric(38, 18),
	"h1_buys" integer,
	"h1_sells" integer,
	"h24_buys" integer,
	"h24_sells" integer,
	"fdv_usd" numeric(38, 18),
	"market_cap_usd" numeric(38, 18),
	"pair_created_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" DROP CONSTRAINT "token_risk_score_range";--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "fetched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "fresh_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "status" text;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "methodology_version" text;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "representative_pool_address" text;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "largest_pool_liquidity_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "largest_pool_share_bps" integer;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "top_three_pool_share_bps" integer;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "usable_pool_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "excluded_pool_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ADD COLUMN "unavailable_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "methodology_version" text;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "identity_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "market_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "holder_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "observed_facts" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "derived_indicators" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD COLUMN "unavailable_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
UPDATE "token_market_snapshots" SET
	"fetched_at" = "observed_at",
	"fresh_until" = "observed_at",
	"status" = 'LEGACY',
	"methodology_version" = 'legacy-pre-phase4',
	"unavailable_fields" = CASE WHEN "holder_count" IS NULL THEN '[]'::jsonb ELSE '["LEGACY_HOLDER_COUNT_NOT_MIGRATED"]'::jsonb END;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ALTER COLUMN "fetched_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ALTER COLUMN "fresh_until" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "token_market_snapshots" ALTER COLUMN "methodology_version" SET NOT NULL;--> statement-breakpoint
UPDATE "token_risk_snapshots" SET
	"methodology_version" = 'legacy-pre-phase4',
	"observed_facts" = jsonb_build_array(jsonb_build_object(
		'code', 'LEGACY_OPAQUE_RISK_RECORD',
		'score', "score",
		'scoreVersion', "score_version",
		'indicators', "indicators",
		'creatorConcentrationBps', "creator_concentration_bps"
	));--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ALTER COLUMN "methodology_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "token_discovery_evidence" ADD CONSTRAINT "token_discovery_evidence_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_discovery_evidence" ADD CONSTRAINT "token_discovery_evidence_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_enrichment_requests" ADD CONSTRAINT "token_enrichment_requests_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_holder_snapshots" ADD CONSTRAINT "token_holder_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_holder_top_owners" ADD CONSTRAINT "token_holder_top_owners_holder_snapshot_id_token_holder_snapshots_id_fk" FOREIGN KEY ("holder_snapshot_id") REFERENCES "public"."token_holder_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_identity_snapshots" ADD CONSTRAINT "token_identity_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_pool_snapshots" ADD CONSTRAINT "token_pool_snapshots_market_snapshot_id_token_market_snapshots_id_fk" FOREIGN KEY ("market_snapshot_id") REFERENCES "public"."token_market_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_discovery_identity_uq" ON "token_discovery_evidence" USING btree ("token_id","transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "token_enrichment_request_bucket_uq" ON "token_enrichment_requests" USING btree ("token_id","tier","freshness_bucket");--> statement-breakpoint
CREATE INDEX "token_enrichment_pending_idx" ON "token_enrichment_requests" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_holder_observation_uq" ON "token_holder_snapshots" USING btree ("token_id","provider","observed_at");--> statement-breakpoint
CREATE INDEX "token_holder_recent_idx" ON "token_holder_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_holder_owner_rank_uq" ON "token_holder_top_owners" USING btree ("holder_snapshot_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "token_identity_observation_uq" ON "token_identity_snapshots" USING btree ("token_id","provider","observed_at");--> statement-breakpoint
CREATE INDEX "token_identity_recent_idx" ON "token_identity_snapshots" USING btree ("token_id","observed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_pool_snapshot_identity_uq" ON "token_pool_snapshots" USING btree ("market_snapshot_id","pool_address");--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_identity_snapshot_id_token_identity_snapshots_id_fk" FOREIGN KEY ("identity_snapshot_id") REFERENCES "public"."token_identity_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_market_snapshot_id_token_market_snapshots_id_fk" FOREIGN KEY ("market_snapshot_id") REFERENCES "public"."token_market_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" ADD CONSTRAINT "token_risk_snapshots_holder_snapshot_id_token_holder_snapshots_id_fk" FOREIGN KEY ("holder_snapshot_id") REFERENCES "public"."token_holder_snapshots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "token_risk_observation_uq" ON "token_risk_snapshots" USING btree ("token_id","observed_at","methodology_version");--> statement-breakpoint
ALTER TABLE "token_market_snapshots" DROP COLUMN "holder_count";--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" DROP COLUMN "score";--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" DROP COLUMN "score_version";--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" DROP COLUMN "indicators";--> statement-breakpoint
ALTER TABLE "token_risk_snapshots" DROP COLUMN "creator_concentration_bps";
