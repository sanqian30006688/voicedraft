ALTER TABLE "autopilot_settings" ALTER COLUMN "start_hour" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ALTER COLUMN "end_hour" SET DEFAULT 24;--> statement-breakpoint
-- 旧默认 8–23 的一律改成全天（2026-11-13 起默认 24 小时都可以发）
UPDATE "autopilot_settings" SET "start_hour" = 0, "end_hour" = 24 WHERE "start_hour" = 8 AND "end_hour" = 23;
