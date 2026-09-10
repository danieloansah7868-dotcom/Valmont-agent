CREATE TABLE "studio_shop_agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"phone" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"balance_minor" integer DEFAULT 0 NOT NULL,
	"invited_by" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_agent_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_agent_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_wallet_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_minor" integer NOT NULL,
	"balance_after_minor" integer NOT NULL,
	"order_id" uuid,
	"note" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_agent_settings" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"discount_percent" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_shop_agents" ADD CONSTRAINT "studio_shop_agents_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_agent_sessions" ADD CONSTRAINT "studio_shop_agent_sessions_agent_id_studio_shop_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."studio_shop_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_agent_tokens" ADD CONSTRAINT "studio_shop_agent_tokens_agent_id_studio_shop_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."studio_shop_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_wallet_entries" ADD CONSTRAINT "studio_shop_wallet_entries_agent_id_studio_shop_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."studio_shop_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_agent_settings" ADD CONSTRAINT "studio_shop_agent_settings_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_shop_agents_draft_email_unique" ON "studio_shop_agents" USING btree ("draft_id","email");--> statement-breakpoint
CREATE INDEX "studio_shop_agents_draft_idx" ON "studio_shop_agents" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "studio_shop_agent_sessions_agent_idx" ON "studio_shop_agent_sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "studio_shop_agent_tokens_agent_idx" ON "studio_shop_agent_tokens" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "studio_shop_wallet_entries_agent_created_idx" ON "studio_shop_wallet_entries" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "studio_shop_wallet_entries_draft_created_idx" ON "studio_shop_wallet_entries" USING btree ("draft_id","created_at");
