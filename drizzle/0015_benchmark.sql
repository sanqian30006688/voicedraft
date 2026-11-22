CREATE TABLE "benchmark_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"industry" text,
	"industry_source" text DEFAULT 'auto' NOT NULL,
	"public_rank" boolean DEFAULT false NOT NULL,
	"public_since" timestamp with time zone,
	"weekly_report" boolean DEFAULT true NOT NULL,
	"last_report_at" timestamp with time zone,
	"snapshot_tried_day" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "x_stat_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"x_user_id" text NOT NULL,
	"day" text NOT NULL,
	"followers" integer NOT NULL,
	"following" integer NOT NULL,
	"tweets" integer NOT NULL,
	"listed" integer DEFAULT 0 NOT NULL,
	"likes" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "benchmark_profiles" ADD CONSTRAINT "benchmark_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "x_stat_snapshots" ADD CONSTRAINT "x_stat_snapshots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "x_stat_snapshots_user_day_idx" ON "x_stat_snapshots" USING btree ("user_id","day");