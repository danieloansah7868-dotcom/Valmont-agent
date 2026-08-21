CREATE TABLE "studio_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"access_code" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"subtotal" integer DEFAULT 0 NOT NULL,
	"delivery_fee" integer DEFAULT 0 NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"lines_json" jsonb NOT NULL,
	"customer_name" text NOT NULL,
	"customer_phone" text NOT NULL,
	"customer_email" text,
	"customer_address" text,
	"payment_method" text NOT NULL,
	"payment_ref" text,
	"paid_at" timestamp with time zone,
	"fulfilled_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"merchant_note" text,
	CONSTRAINT "studio_orders_access_code_unique" UNIQUE("access_code")
);
--> statement-breakpoint
ALTER TABLE "studio_orders" ADD CONSTRAINT "studio_orders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD CONSTRAINT "studio_orders_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_orders_owner_created_idx" ON "studio_orders" USING btree ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_orders_draft_idx" ON "studio_orders" USING btree ("draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "studio_orders_access_code_idx" ON "studio_orders" USING btree ("access_code");