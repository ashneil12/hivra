-- Rename scheduled-tasks tables to deprecated names ahead of T+7d drop.
--
-- The user-facing Scheduled Tasks dashboard feature has been removed
-- (now lives inside the WebUI agent surface). The tables are no
-- longer read or written by app code. Renaming makes any orphan
-- caller fail loudly so we can detect lingering readers across the
-- ~130 production VMs before the destructive DROP scheduled for
-- 2026-05-18.
--
-- Tables:
--  - hermes_scheduled_tasks → _deprecated_hermes_scheduled_tasks_20260511
--      V2 table with actual user rows. May still contain data.
--  - scheduled_tasks → _deprecated_scheduled_tasks_20260511
--      V1 legacy stub (single id column, 0 rows, unused).
--  - task_history → _deprecated_task_history_20260511
--      V1 legacy stub (single id column, 0 rows, unused).
--
-- The destructive DROP migration is queued at
-- dashboard/supabase/_pending_destructive_migrations/
-- and MUST be MANUALLY applied on or after 2026-05-18.

ALTER TABLE IF EXISTS public.hermes_scheduled_tasks
  RENAME TO _deprecated_hermes_scheduled_tasks_20260511;

ALTER TABLE IF EXISTS public.scheduled_tasks
  RENAME TO _deprecated_scheduled_tasks_20260511;

ALTER TABLE IF EXISTS public.task_history
  RENAME TO _deprecated_task_history_20260511;
