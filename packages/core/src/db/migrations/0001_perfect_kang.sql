CREATE TABLE IF NOT EXISTS "authenticator_backups" (
	"identity_id" uuid PRIMARY KEY NOT NULL,
	"ciphertext" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "authenticator_backups" ADD CONSTRAINT "authenticator_backups_identity_id_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
