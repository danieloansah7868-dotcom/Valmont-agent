ALTER TABLE "studio_orders" ADD COLUMN "agent_id" text;--> statement-breakpoint
CREATE INDEX "studio_orders_agent_created_idx" ON "studio_orders" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_shop_wallet_entries_order_purchase_unique" ON "studio_shop_wallet_entries" USING btree ("order_id") WHERE "kind" = 'purchase';--> statement-breakpoint
CREATE UNIQUE INDEX "studio_shop_wallet_entries_order_refund_unique" ON "studio_shop_wallet_entries" USING btree ("order_id") WHERE "kind" = 'refund';
