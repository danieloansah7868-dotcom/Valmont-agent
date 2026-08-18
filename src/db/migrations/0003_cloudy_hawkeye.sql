CREATE TABLE "studio_import_fences" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"lock_token" text NOT NULL,
	"generation" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "studio_import_fences" ADD CONSTRAINT "studio_import_fences_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;