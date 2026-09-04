CREATE TABLE "studio_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider" text DEFAULT 'techchief' NOT NULL,
	"api_key_enc" text NOT NULL,
	"key_prefix" text NOT NULL,
	"webhook_secret_enc" text,
	"status" text DEFAULT 'unverified' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"wallet_balance" numeric(12,2),
	"low_balance" boolean DEFAULT false NOT NULL,
	"account_status" text,
	"last_error" text,
	"bundles_json" jsonb,
	"bundles_synced_at" timestamp with time zone,
	"poll_window_start" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_integrations" ADD CONSTRAINT "studio_integrations_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_integrations" ADD CONSTRAINT "studio_integrations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_integrations_draft_provider_unique" ON "studio_integrations" USING btree ("draft_id","provider");--> statement-breakpoint
CREATE INDEX "studio_integrations_owner_idx" ON "studio_integrations" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "studio_deliveries_provider_ref_idx" ON "studio_deliveries" USING btree ("provider_ref");
