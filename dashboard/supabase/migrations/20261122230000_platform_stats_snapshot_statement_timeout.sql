-- Give the platform-stats snapshot room to finish.
--
-- The hourly rollup cron calls compute_platform_stats_snapshot through
-- PostgREST as service_role. service_role has no statement_timeout of its
-- own, so it inherits authenticator's 8s; the snapshot scans a 30-day
-- window and averages ~6s on prod, so a large share of calls were killed at
-- the wall — the ops feed showed "All platform stats snapshots failed" on
-- most runs and specific dates failing for months. A per-function SET
-- applies only while this function executes, leaving every other
-- service_role query on the inherited 8s.
alter function public.compute_platform_stats_snapshot(date)
  set statement_timeout = '60s';
