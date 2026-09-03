CREATE TABLE "studio_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"order_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"line_index" integer NOT NULL,
	"unit_index" integer NOT NULL,
	"item_id" text NOT NULL,
	"item_name" text NOT NULL,
	"network" text NOT NULL,
	"data_mb" integer NOT NULL,
	"validity" text,
	"recipient_phone" text NOT NULL,
	"provider" text DEFAULT 'simulator' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_ref" text,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_deliveries" ADD CONSTRAINT "studio_deliveries_order_id_studio_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."studio_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_deliveries" ADD CONSTRAINT "studio_deliveries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_deliveries_order_idx" ON "studio_deliveries" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "studio_deliveries_owner_created_idx" ON "studio_deliveries" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_deliveries_order_line_unit_unique" ON "studio_deliveries" USING btree ("order_id","line_index","unit_index");
