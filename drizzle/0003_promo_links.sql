CREATE TABLE "promo_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"blurb" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promo_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'ask' NOT NULL,
	"default_link_id" uuid
);
--> statement-breakpoint
ALTER TABLE "promo_links" ADD CONSTRAINT "promo_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_settings" ADD CONSTRAINT "promo_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo_settings" ADD CONSTRAINT "promo_settings_default_link_id_promo_links_id_fk" FOREIGN KEY ("default_link_id") REFERENCES "public"."promo_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "promo_links_user_idx" ON "promo_links" USING btree ("user_id","created_at");