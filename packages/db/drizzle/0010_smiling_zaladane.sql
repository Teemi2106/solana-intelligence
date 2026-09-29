ALTER TABLE "wallet_behavior_observations" ADD COLUMN "sell_trade_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD COLUMN "acquisition_trade_id" uuid;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD COLUMN "realized_raw_amount" numeric(78, 0);--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD COLUMN "accounting_methodology_version" text;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_sell_trade_id_wallet_trades_id_fk" FOREIGN KEY ("sell_trade_id") REFERENCES "public"."wallet_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_behavior_observations" ADD CONSTRAINT "wallet_behavior_observations_acquisition_trade_id_wallet_trades_id_fk" FOREIGN KEY ("acquisition_trade_id") REFERENCES "public"."wallet_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "wallet_behavior_observation_realization_idx" ON "wallet_behavior_observations" USING btree ("wallet_id","feature_kind","accounting_methodology_version","sell_trade_id");