CREATE TABLE "hot_topic_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"min_sources" integer DEFAULT 3 NOT NULL,
	"daily_cap" integer DEFAULT 3 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"post_id" uuid NOT NULL,
	"tweet_id" text NOT NULL,
	"kind" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"d1" jsonb,
	"d1_at" timestamp with time zone,
	"d7" jsonb,
	"d7_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "also_seen" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "hot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feed_items" ADD COLUMN "hot_sources" integer;--> statement-breakpoint
ALTER TABLE "hot_topic_settings" ADD CONSTRAINT "hot_topic_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_metrics" ADD CONSTRAINT "post_metrics_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "post_metrics_post_idx" ON "post_metrics" USING btree ("post_id");--> statement-breakpoint
CREATE INDEX "post_metrics_user_idx" ON "post_metrics" USING btree ("user_id","published_at");