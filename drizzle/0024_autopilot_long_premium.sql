ALTER TABLE "autopilot_settings" ADD COLUMN "long_form" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "premium" boolean;--> statement-breakpoint
ALTER TABLE "x_accounts" ADD COLUMN "premium_checked_at" timestamp with time zone;