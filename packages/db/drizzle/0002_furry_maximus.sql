ALTER TABLE "transaction_token_flows" DROP CONSTRAINT "transaction_token_flows_transaction_id_wallet_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "wallet_classification_evidence" DROP CONSTRAINT "wallet_classification_evidence_transaction_id_wallet_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" DROP CONSTRAINT "wallet_inventory_lots_source_transaction_id_wallet_transactions_id_fk";
--> statement-breakpoint
ALTER TABLE "transaction_token_flows" ADD CONSTRAINT "token_flow_transaction_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_classification_evidence" ADD CONSTRAINT "class_evidence_tx_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_inventory_lots" ADD CONSTRAINT "inventory_source_tx_fk" FOREIGN KEY ("source_transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE no action ON UPDATE no action;