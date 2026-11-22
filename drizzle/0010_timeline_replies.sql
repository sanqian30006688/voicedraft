ALTER TABLE "reply_items" ADD COLUMN "source" text DEFAULT 'mention' NOT NULL;--> statement-breakpoint
ALTER TABLE "reply_items" ADD COLUMN "match_reason" text;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_interval_min" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_since_id" text;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_handles" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_daily_cap" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_read_limit" integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "timeline_paused_reason" text;