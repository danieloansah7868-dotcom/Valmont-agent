CREATE TABLE IF NOT EXISTS "studio_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'test' NOT NULL,
	"api_url_enc" text,
	"api_key_enc" text,
	"webhook_secret_enc" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
