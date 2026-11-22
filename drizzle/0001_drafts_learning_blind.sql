CREATE TABLE "blind_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"style_card_version" integer NOT NULL,
	"items" jsonb NOT NULL,
	"guesses" jsonb,
	"misjudge_rate" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sentences" jsonb NOT NULL,
	"final_text" text DEFAULT '' NOT NULL,
	"style_card_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "style_learnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"edit_count" integer NOT NULL,
	"last_edit_at" timestamp with time zone NOT NULL,
	"suggestion" jsonb NOT NULL,
	"base_version" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edit_logs" ADD COLUMN "draft_id" uuid;--> statement-breakpoint
ALTER TABLE "blind_tests" ADD CONSTRAINT "blind_tests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "style_learnings" ADD CONSTRAINT "style_learnings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blind_tests_user_idx" ON "blind_tests" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "drafts_user_idx" ON "drafts" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "style_learnings_user_idx" ON "style_learnings" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "edit_logs" ADD CONSTRAINT "edit_logs_draft_id_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."drafts"("id") ON DELETE set null ON UPDATE no action;