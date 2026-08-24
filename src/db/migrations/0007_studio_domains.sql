CREATE TABLE "studio_domains" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"status" text DEFAULT 'not_set' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "studio_domains_hostname_unique" UNIQUE("hostname")
);
--> statement-breakpoint
CREATE TABLE "studio_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'test' NOT NULL,
	"api_url_enc" text,
	"api_key_enc" text,
	"webhook_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "preparing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "out_for_delivery_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "refunded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "studio_orders" ADD COLUMN "status_history" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "studio_domains" ADD CONSTRAINT "studio_domains_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_domains" ADD CONSTRAINT "studio_domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_domains_owner_idx" ON "studio_domains" USING btree ("owner_id");