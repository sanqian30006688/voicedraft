CREATE TABLE "api_usage" (
	"hour" timestamp with time zone NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"units" bigint DEFAULT 0 NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_report_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"hour" integer DEFAULT 9 NOT NULL,
	"tz" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"last_sent_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "daily_report_settings" ADD CONSTRAINT "daily_report_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_usage_hour_idx" ON "api_usage" USING btree ("hour","provider","kind");