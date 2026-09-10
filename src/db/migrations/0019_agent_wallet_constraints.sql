ALTER TABLE "studio_shop_agents" ADD CONSTRAINT "studio_shop_agents_balance_non_negative" CHECK ("balance_minor" >= 0);--> statement-breakpoint
ALTER TABLE "studio_shop_wallet_entries" ADD CONSTRAINT "studio_shop_wallet_entries_amount_nonzero" CHECK ("amount_minor" <> 0);
