CREATE TABLE "feed_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"source_id" uuid,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"url" text,
	"author" text,
	"published_at" timestamp with time zone,
	"points" jsonb,
	"status" text DEFAULT 'new' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"handle" text NOT NULL,
	"title" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"cursor" integer,
	"last_fetched_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tg_bindings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" text,
	"bind_code" text,
	"bind_code_expires_at" timestamp with time zone,
	"bound_at" timestamp with time zone,
	CONSTRAINT "tg_bindings_chat_id_unique" UNIQUE("chat_id"),
	CONSTRAINT "tg_bindings_bind_code_unique" UNIQUE("bind_code")
);
--> statement-breakpoint
ALTER TABLE "drafts" ADD COLUMN "source_item_id" uuid;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feed_items" ADD CONSTRAINT "feed_items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sources" ADD CONSTRAINT "sources_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tg_bindings" ADD CONSTRAINT "tg_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "feed_items_user_hash_idx" ON "feed_items" USING btree ("user_id","content_hash");--> statement-breakpoint
CREATE INDEX "feed_items_user_created_idx" ON "feed_items" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_user_type_handle_idx" ON "sources" USING btree ("user_id","type","handle");--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_source_item_id_feed_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."feed_items"("id") ON DELETE set null ON UPDATE no action;