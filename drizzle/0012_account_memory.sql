CREATE TABLE "account_memories" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"memory" jsonb NOT NULL,
	"source" text DEFAULT 'auto' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"posts_at_build" integer DEFAULT 0 NOT NULL,
	"built_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auto_posts" ADD COLUMN "quality" integer;--> statement-breakpoint
ALTER TABLE "account_memories" ADD CONSTRAINT "account_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;