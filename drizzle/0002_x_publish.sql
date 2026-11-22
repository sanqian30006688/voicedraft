CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"draft_id" uuid,
	"tweets" jsonb NOT NULL,
	"status" text NOT NULL,
	"scheduled_at" timestamp with time zone,
	"post_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"handle" text,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reply_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"tweet_id" text NOT NULL,
	"conversation_id" text,
	"author_id" text NOT NULL,
	"author_handle" text NOT NULL,
	"author_name" text,
	"text" text NOT NULL,
	"in_reply_to_text" text,
	"tweeted_at" timestamp with time zone,
	"candidates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"skip_reason" text,
	"reply_text" text,
	"reply_post_id" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"x_user_id" text NOT NULL,
	"handle" text NOT NULL,
	"name" text,
	"scopes" text NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text,
	"expires_at" timestamp with time zone NOT NULL,
	"auth_error" text,
	"auto_reply_enabled" boolean DEFAULT false NOT NULL,
	"auto_reply_interval_min" integer DEFAULT 15 NOT NULL,
	"mentions_since_id" text,
	"last_checked_at" timestamp with time zone,
	"skip_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skip_handles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_rounds" integer DEFAULT 3 NOT NULL,
	"paused_until" timestamp with time zone,
	"paused_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"return_to" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reply_items" ADD CONSTRAINT "reply_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD CONSTRAINT "x_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_oauth_states" ADD CONSTRAINT "x_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "posts_user_idx" ON "posts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "posts_due_idx" ON "posts" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "reply_items_user_tweet_idx" ON "reply_items" USING btree ("user_id","tweet_id");--> statement-breakpoint
CREATE INDEX "reply_items_user_status_idx" ON "reply_items" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "x_accounts_user_idx" ON "x_accounts" USING btree ("user_id");