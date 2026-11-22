-- Give the platform-stats snapshot room to finish.
--
-- The hourly rollup cron calls compute_platform_stats_snapshot through
-- PostgREST as service_role. service_role has no statement_timeout of its
-- own, so it inherits authenticator's 8s; the snapshot scans a 30-day
-- window and averages ~6s on prod, so a large share of calls were killed at
-- the wall — the ops feed showed "All platform stats snapshots failed" on
-- most runs and specific dates failing for months.
--
-- A bare PostgreSQL function SET does not extend the timeout of a statement
-- that is already running — but this function is invoked as a direct
-- PostgREST /rpc/ call, and PostgREST hoists the called function's
-- statement_timeout into the request transaction (postgrest#3001, verified
-- in the Supabase timeouts docs). The 60s therefore applies from statement
-- start for this call path only; direct/pooler SQL keeps the caller's
-- timeout, which is what we want.
alter function public.compute_platform_stats_snapshot(date)
  set statement_timeout = '60s';
