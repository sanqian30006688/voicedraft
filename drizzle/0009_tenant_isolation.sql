-- 定时帖记下排期时的 X 账号；已在排期中的帖子按当前绑定的账号补上
ALTER TABLE "posts" ADD COLUMN "x_user_id" text;--> statement-breakpoint
UPDATE "posts" SET "x_user_id" = "x_accounts"."x_user_id" FROM "x_accounts" WHERE "x_accounts"."user_id" = "posts"."user_id" AND "posts"."status" IN ('scheduled', 'failed');--> statement-breakpoint
-- 一个 X 账号只能绑定一个用户：以前同一个 X 账号被多个用户绑定过的，只保留最近一次连接
DELETE FROM "x_accounts" a USING "x_accounts" b WHERE a."x_user_id" = b."x_user_id" AND (a."updated_at" < b."updated_at" OR (a."updated_at" = b."updated_at" AND a."id" < b."id"));--> statement-breakpoint
CREATE UNIQUE INDEX "x_accounts_x_user_idx" ON "x_accounts" USING btree ("x_user_id");
