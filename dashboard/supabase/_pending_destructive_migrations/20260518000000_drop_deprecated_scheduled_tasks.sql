-- *** DO NOT APPLY BEFORE 2026-05-18 ***
--
-- This is a QUEUED destructive migration. It is intentionally placed
-- OUTSIDE `dashboard/supabase/migrations/` so `supabase db push` does
-- NOT auto-apply it.
--
-- To apply on or after 2026-05-18:
--   1. Confirm no production errors mention "_deprecated_*_20260511"
--      across the ~130 production VMs (check Vercel logs +
--      Supabase logs).
--   2. `mv this file into dashboard/supabase/migrations/`
--   3. `cd dashboard && supabase db push`
--
-- 7-day rationale: on 2026-05-11 the Scheduled Tasks feature was
-- removed from the dashboard and the underlying tables were renamed
-- to `_deprecated_*_20260511` to surface any orphan reader as a
-- "relation does not exist" error. If no such errors are observed
-- for 7 days, the rename is safe to make permanent via DROP.

DROP TABLE IF EXISTS public._deprecated_hermes_scheduled_tasks_20260511 CASCADE;
DROP TABLE IF EXISTS public._deprecated_scheduled_tasks_20260511 CASCADE;
DROP TABLE IF EXISTS public._deprecated_task_history_20260511 CASCADE;
