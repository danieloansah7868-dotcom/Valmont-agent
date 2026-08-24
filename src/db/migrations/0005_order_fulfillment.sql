ALTER TABLE "studio_orders" ADD COLUMN "preparing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "out_for_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "status_history" jsonb DEFAULT '[]'::jsonb NOT NULL;
