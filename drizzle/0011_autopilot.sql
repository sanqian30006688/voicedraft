CREATE TABLE "auto_posts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"feed_item_id" uuid,
	"source_id" uuid,
	"text" text DEFAULT '' NOT NULL,
	"similarity" integer,
	"status" text NOT NULL,
	"post_id" uuid,
	"note" text,
	"tg_notified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "autopilot_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"mode" text DEFAULT 'review' NOT NULL,
	"daily_cap" integer DEFAULT 5 NOT NULL,
	"min_gap_min" integer DEFAULT 90 NOT NULL,
	"start_hour" integer DEFAULT 8 NOT NULL,
	"end_hour" integer DEFAULT 23 NOT NULL,
	"tz" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"attach_link" boolean DEFAULT false NOT NULL,
	"with_promo" boolean DEFAULT false NOT NULL,
	"max_age_hours" integer DEFAULT 48 NOT NULL,
	"per_source_daily" integer DEFAULT 2 NOT NULL,
	"instruction" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "url" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "since_id" text;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "seen" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "interval_min" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "autopilot" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "sources" ADD COLUMN "auto_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_feed_item_id_feed_items_id_fk" FOREIGN KEY ("feed_item_id") REFERENCES "public"."feed_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD CONSTRAINT "autopilot_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_posts_user_item_idx" ON "auto_posts" USING btree ("user_id","feed_item_id");--> statement-breakpoint
CREATE INDEX "auto_posts_user_created_idx" ON "auto_posts" USING btree ("user_id","created_at");