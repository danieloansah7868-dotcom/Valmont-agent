CREATE TABLE "studio_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"template_version" integer DEFAULT 1 NOT NULL,
	"theme_version" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"brief" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_drafts" ADD CONSTRAINT "studio_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "studio_drafts_owner_updated_idx" ON "studio_drafts" USING btree ("owner_id","updated_at");