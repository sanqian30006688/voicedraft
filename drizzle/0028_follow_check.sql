CREATE TABLE "follow_people" (
	"user_id" uuid NOT NULL,
	"own_x_user_id" text NOT NULL,
	"target_id" text NOT NULL,
	"handle" text NOT NULL,
	"name" text,
	"verified_type" text,
	"followers" integer DEFAULT 0 NOT NULL,
	"following" integer DEFAULT 0 NOT NULL,
	"i_follow" boolean DEFAULT false NOT NULL,
	"follows_me" boolean DEFAULT false NOT NULL,
	"lost_at" timestamp with time zone,
	"ignored" boolean DEFAULT false NOT NULL,
	"unfollowed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_scans" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"own_x_user_id" text,
	"scanned_at" timestamp with time zone,
	"following_count" integer DEFAULT 0 NOT NULL,
	"followers_count" integer DEFAULT 0 NOT NULL,
	"est_following" integer,
	"est_followers" integer,
	"est_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "follow_people" ADD CONSTRAINT "follow_people_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_scans" ADD CONSTRAINT "follow_scans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "follow_people_uniq" ON "follow_people" USING btree ("user_id","own_x_user_id","target_id");