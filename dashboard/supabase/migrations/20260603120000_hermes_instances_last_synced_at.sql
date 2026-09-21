-- Fleet-sync cursor for the daily :stable rollout cron.
--
-- GET /api/cron/redeploy-webui-instances (Vercel cron, "0 10 * * *") rolls
-- the whole WebUI fleet to the latest :stable image, one FLEET_SYNC_BATCH_LIMIT
-- (50) batch per run. It picks the least-recently-synced VMs first and bumps
-- this column on every successful redeploy so the NEXT run advances to the
-- next-oldest cohort instead of re-rolling the same VMs forever.
--
-- Before this column existed the GET handler ordered by `last_activity_at`,
-- which applyLiveUpdate never changes — so every daily run re-redeployed the
-- same ~50 longest-idle VMs and a ~678-instance fleet never converged. The
-- column is written by applyLiveUpdate (the shared redeploy path used by the
-- fleet-sync cron, manual redeploys, resizes, and recovery), so ANY path that
-- recreates a VM from the latest :stable advances its cursor.
--
-- Nullable with NO default on purpose: existing rows stay NULL so the first
-- few cron runs treat every VM as never-synced (NULLS FIRST) and the whole
-- fleet picks up the latest image before the cursor starts cycling.

alter table public.hermes_instances
  add column if not exists last_synced_at timestamptz;

comment on column public.hermes_instances.last_synced_at is
  'Timestamp of the last successful applyLiveUpdate (agent container recreated '
  'from the latest :stable image). The daily fleet-sync cron '
  '(GET /api/cron/redeploy-webui-instances) orders by this column NULLS FIRST '
  'so the least-recently-synced VMs roll first; NULL means never synced via '
  'this mechanism. Distinct from last_activity_at, which tracks user traffic.';

-- Fleet-sync query is
--   `where backend='webui' and lifecycle_state in (...) order by last_synced_at nulls first, id`.
-- Match the index null-ordering to the query (ASC NULLS FIRST) and carry id as
-- the documented deterministic tiebreaker so the cron makes forward progress
-- O(batch) instead of sorting the whole fleet each tick.
create index if not exists hermes_instances_webui_fleet_sync_idx
  on public.hermes_instances (last_synced_at asc nulls first, id)
  where backend = 'webui';
