CREATE TABLE "inspirations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source" text NOT NULL,
	"tweet_id" text NOT NULL,
	"author_id" text,
	"author_handle" text NOT NULL,
	"author_name" text,
	"text" text NOT NULL,
	"tweeted_at" timestamp with time zone,
	"quote_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD COLUMN "quote_tweet_id" text;--> statement-breakpoint
ALTER TABLE "inspirations" ADD CONSTRAINT "inspirations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inspirations_user_tweet_idx" ON "inspirations" USING btree ("user_id","tweet_id");--> statement-breakpoint
CREATE INDEX "inspirations_user_status_idx" ON "inspirations" USING btree ("user_id","status","created_at");