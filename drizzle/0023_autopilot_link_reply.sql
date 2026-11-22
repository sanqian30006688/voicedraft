ALTER TABLE "auto_posts" ADD COLUMN "reply_link" text;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "link_reply" boolean DEFAULT false NOT NULL;