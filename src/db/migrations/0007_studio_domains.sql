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
ALTER TABLE "studio_domains" ADD CONSTRAINT "studio_domains_draft_id_studio_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."studio_drafts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "studio_domains" ADD CONSTRAINT "studio_domains_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "studio_domains_owner_idx" ON "studio_domains" USING btree ("owner_id");
