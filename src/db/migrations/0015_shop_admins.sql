CREATE TABLE "studio_shop_admins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"permissions" text DEFAULT '[]' NOT NULL,
	"password_hash" text,
	"status" text DEFAULT 'invited' NOT NULL,
	"invited_by" text,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_admin_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "studio_shop_admin_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"admin_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_shop_admins" ADD CONSTRAINT "studio_shop_admins_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_admin_sessions" ADD CONSTRAINT "studio_shop_admin_sessions_admin_id_studio_shop_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."studio_shop_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "studio_shop_admin_tokens" ADD CONSTRAINT "studio_shop_admin_tokens_admin_id_studio_shop_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."studio_shop_admins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "studio_shop_admins_draft_email_unique" ON "studio_shop_admins" USING btree ("draft_id","email");--> statement-breakpoint
CREATE INDEX "studio_shop_admins_draft_idx" ON "studio_shop_admins" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "studio_shop_admin_sessions_admin_idx" ON "studio_shop_admin_sessions" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "studio_shop_admin_tokens_admin_idx" ON "studio_shop_admin_tokens" USING btree ("admin_id");
