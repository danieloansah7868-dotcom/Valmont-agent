ALTER TABLE "studio_orders" ADD COLUMN "payment_mode" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_domains" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "studio_domains" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_domains" ADD COLUMN "last_checked_at" timestamp with time zone;
