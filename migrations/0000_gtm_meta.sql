CREATE SCHEMA IF NOT EXISTS "gtm";
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gtm"."meta" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
