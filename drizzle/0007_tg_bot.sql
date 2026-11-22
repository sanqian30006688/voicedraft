ALTER TABLE "reply_items" ADD COLUMN "tg_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tg_bindings" ADD COLUMN "bot_state" jsonb DEFAULT '{}'::jsonb NOT NULL;