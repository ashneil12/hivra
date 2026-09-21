-- Fairness cursor for the daily fleet-sync sweep.
--
-- GET /api/cron/redeploy-webui-instances ordered by `last_synced_at NULLS
-- FIRST`, and `last_synced_at` is only stamped on a SUCCESSFUL applyLiveUpdate
-- launch. So a box that fails every redeploy never advanced the sort key and
-- re-sorted to the FRONT of every subsequent tick, forever — permanently
-- occupying batch slots that healthy boxes needed.
--
-- Verified on prod 2026-07-16: a tick selected fixturecase18-…, the redeploy failed,
-- and `last_synced_at` stayed at 2026-06-21. Five such rows sat at the head of
-- the queue ahead of every healthy box (5/50 slots = 10% of each tick). The
-- sweep still converged at that ratio, but it degrades with no floor: at ~50
-- dead rows the entire batch is consumed by boxes that cannot succeed and no
-- healthy box is ever synced again.
--
-- Fix: order by ATTEMPT, not SUCCESS. The sweep stamps this column for every
-- row it selects, before doing any work, so the cursor advances on failure and
-- skip exactly as it does on success. That makes the sweep a round-robin: a
-- permanently-broken box is retried once per full fleet cycle and costs its
-- fair share of slots, never more. Deliberately NOT a permanent ejection —
-- that is the starvation bug PR #598 fixed and it must not come back.
--
-- `last_synced_at` KEEPS its meaning (last confirmed roll onto :stable) and is
-- untouched: it is the honest convergence signal that the ops fleet-live-update
-- CLI filters on (`isStaleSince`), and conflating "we tried" with "it worked"
-- would make a fleet of dead boxes report as fully synced.
--
-- Nullable with NO default on purpose, mirroring last_synced_at: existing rows
-- stay NULL and sort first, so the whole fleet gets one attempt before the
-- round-robin starts cycling.

alter table public.hermes_instances
  add column if not exists last_sync_attempt_at timestamptz;

comment on column public.hermes_instances.last_sync_attempt_at is
  'Timestamp of the last fleet-sync ATTEMPT (success, failure, or skip), stamped '
  'up-front for every row the sweep selects. The daily fleet-sync cron '
  '(GET /api/cron/redeploy-webui-instances) orders by this column NULLS FIRST so '
  'the queue is a fair round-robin and a permanently-failing box cannot pin '
  'itself to the head and starve healthy boxes. Distinct from last_synced_at, '
  'which is only stamped on SUCCESS and remains the true convergence signal.';

-- Match the sweep's ORDER BY (last_sync_attempt_at asc nulls first, id).
-- Unlike the older hermes_instances_webui_fleet_sync_idx, this is NOT restricted
-- to `backend = 'webui'`: the sweep has since widened to WEBFREE_BACKENDS
-- ('webui','gateway'), so a webui-only partial index no longer covers the
-- queries it is meant to serve.
create index if not exists hermes_instances_fleet_sync_attempt_idx
  on public.hermes_instances (last_sync_attempt_at asc nulls first, id)
  where backend in ('webui', 'gateway');

-- Seed the cursor from the existing success cursor so the first ticks after
-- deploy keep the ordering operators already expect (longest-overdue first)
-- instead of re-randomising the whole fleet by id. Rows that have never synced
-- stay NULL and still sort first.
update public.hermes_instances
  set last_sync_attempt_at = last_synced_at
  where last_sync_attempt_at is null
    and last_synced_at is not null;
