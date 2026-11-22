ALTER TABLE "auto_posts" ADD COLUMN "image_id" uuid;--> statement-breakpoint
ALTER TABLE "autopilot_settings" ADD COLUMN "with_image" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auto_posts" ADD CONSTRAINT "auto_posts_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE set null ON UPDATE no action;