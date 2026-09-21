-- Inactivity-shutdown bookkeeping for hermes_instances.
--
-- Hermes agents are pitched as "always on" — a user can text/ping their
-- agent any time. So we don't shut down for short inactivity (5 min,
-- 30 min, etc. would defeat the product). Instead, we only shut down
-- when an instance has been completely untouched for days, which is the
-- "user signed up, kicked the tires, never came back" pattern. Reclaiming
-- those VMs is what enables aggressive RAM packing on the pve hosts:
-- a 60GB-usable host can fit 100+ free-tier agents instead of 60 because
-- abandoned agents contribute 0 RAM after the sweep.
--
-- Schedule (driven by /api/cron/inactivity-sweep, hourly):
--   Free tier (credit_base, token_base): 4 days idle → graceful qm shutdown
--   Paid tier (operator, fleet, command): 7 days idle → graceful qm shutdown
--
-- Wake: existing POST /api/instances/[id] {action:"start"} starts the VM
-- back up; this migration also clears paused_reason on a successful start
-- so the row exits the "swept" state cleanly.
--
-- last_activity_at defaults to now() so existing rows are NOT immediately
-- swept the first time the cron runs — gives us a full 4/7-day window
-- from migration time before anything happens.

alter table public.hermes_instances
  add column if not exists last_activity_at timestamptz not null default now();

alter table public.hermes_instances
  add column if not exists paused_reason text;

comment on column public.hermes_instances.last_activity_at is
  'Timestamp of the last user-driven request that touched this instance '
  '(dashboard fetch, manual lifecycle action, etc.). The inactivity-sweep '
  'cron compares this against the per-tier idle threshold to decide '
  'whether to graceful-shutdown the VM.';

comment on column public.hermes_instances.paused_reason is
  'Why the instance is in lifecycle_state=paused. Currently '
  '''inactivity'' (set by the inactivity-sweep cron) is the only value, '
  'but reserved for future watchdog-driven pauses (e.g. ''ram_cap_hit'' '
  'when a free-tier agent pins its memory cap). NULL when the instance '
  'is not paused or was paused for an unrecorded reason.';

-- Sweep query is `where lifecycle_state='active' and resource_tier in (...) and last_activity_at < cutoff`.
-- This index keeps the cron O(swept-rows) instead of O(fleet) when the fleet grows.
create index if not exists hermes_instances_active_inactivity_idx
  on public.hermes_instances (last_activity_at)
  where lifecycle_state = 'active';
