-- Add profile_name column to scheduled_tasks
ALTER TABLE "public"."scheduled_tasks"
ADD COLUMN "profile_name" text DEFAULT 'default';
-- Add profile_name to histories as well, so history logs know the target profile
ALTER TABLE "public"."task_history"
ADD COLUMN "profile_name" text DEFAULT 'default';
