ALTER TABLE "tg_bindings" ADD COLUMN "tg_username" text;--> statement-breakpoint
ALTER TABLE "tg_bindings" ADD COLUMN "tg_name" text;--> statement-breakpoint
ALTER TABLE "tg_bindings" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
CREATE SEQUENCE IF NOT EXISTS "users_user_no_seq" MINVALUE 10001 START 10001;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "user_no" integer;--> statement-breakpoint
UPDATE "users" u SET "user_no" = s.n FROM (SELECT "id", (10000 + row_number() OVER (ORDER BY "created_at", "id"))::int AS n FROM "users") s WHERE u."id" = s."id";--> statement-breakpoint
SELECT setval('users_user_no_seq', COALESCE((SELECT max("user_no") FROM "users"), 10001), (SELECT count(*) > 0 FROM "users"));--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "user_no" SET DEFAULT nextval('users_user_no_seq');--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "user_no" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_user_no_unique" UNIQUE("user_no");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tg_bindings_username_idx" ON "tg_bindings" (lower("tg_username"));
