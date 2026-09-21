-- Agents-deployed counter — monotonic, single round-trip.
--
-- The previous design derived "all-time successful deploys" from a
-- 7-HEAD-query Promise.all that filtered hermes_instances by current
-- status NOT IN ('error','provisioning') plus an archive count. Two
-- problems hit production on 2026-05-18 (drop from 609 -> 604):
--   1. The formula is non-monotonic. A previously-counted row that
--      flips to provisioning (e.g. via the new recover-unhealthy-active
--      cron in PR #146) subtracts from "all-time."
--   2. The 7-query fan-out multiplies failure surface; the JS-side
--      caller masks any partial fetch failure with `?? 0`, producing
--      wildly wrong numbers when a sub-request trips. We saw 58
--      empty-message `Error:` events in ops_events over 2 days.
--
-- Fix: track "this row was active at least once" as a column on
-- hermes_instances, populated atomically by trigger. Counter becomes
-- COUNT(*) WHERE first_active_at IS NOT NULL + archive count. A row
-- that later flips to error/provisioning keeps its first_active_at
-- timestamp, so the all-time total never decreases.
--
-- Read path collapses to one RPC.

----------------------------------------------------------------------
-- 1. Column + index
----------------------------------------------------------------------

alter table public.hermes_instances
  add column if not exists first_active_at timestamptz;

-- Daily-bucket queries for the 30-day sparkline scan this index.
create index if not exists hermes_instances_first_active_at_idx
  on public.hermes_instances (first_active_at)
  where first_active_at is not null;

comment on column public.hermes_instances.first_active_at is
  'When this row first transitioned to lifecycle_state=''active''. '
  'Set once by trigger and never overwritten — drives the all-time '
  'agents-deployed counter so it cannot decrease when a row is later '
  'demoted to provisioning/error by the recovery crons.';

----------------------------------------------------------------------
-- 2. Trigger — set first_active_at on first transition to active
----------------------------------------------------------------------

create or replace function public.hermes_instances_track_first_active()
returns trigger
language plpgsql
as $$
begin
  if NEW.lifecycle_state = 'active' and NEW.first_active_at is null then
    NEW.first_active_at := coalesce(NEW.last_lifecycle_transition_at, now());
  end if;
  return NEW;
end;
$$;

drop trigger if exists hermes_instances_first_active_trigger
  on public.hermes_instances;

create trigger hermes_instances_first_active_trigger
  before insert or update of lifecycle_state, first_active_at
  on public.hermes_instances
  for each row
  execute function public.hermes_instances_track_first_active();

----------------------------------------------------------------------
-- 3. Backfill
----------------------------------------------------------------------
-- Mark a row as ever-active if any of:
--   - currently in a status that implies it once ran
--     (running, stopped, deleted, redeploying, scheduled_for_deletion)
--   - lifecycle_state has been in an active-ish state (active, paused,
--     suspended, deleted, deleting)
--   - currently broken (error/provisioning) but the recovery cron has
--     touched it (auto_restart_attempts > 0), which only happens for
--     rows that started healthy then degraded
-- Backfill anchor = created_at (stable, predates any state churn).
-- Some rows will be off by minutes from the true first-active time;
-- acceptable for an existing-history backfill. New rows go through the
-- trigger and get exact timestamps.

update public.hermes_instances
set first_active_at = created_at
where first_active_at is null
  and (
    status in ('running', 'stopped', 'deleted', 'redeploying', 'scheduled_for_deletion')
    or lifecycle_state in ('active', 'paused', 'suspended', 'deleted', 'deleting')
    or (status in ('error', 'provisioning') and coalesce(auto_restart_attempts, 0) > 0)
  );

----------------------------------------------------------------------
-- 4. RPC — single round trip returns total + windowed counts + series + first-deploy
----------------------------------------------------------------------
-- Returns one JSON blob so the Node caller doesn't have to fan out.
-- All counts atomic in a single snapshot.
-- Series field is a JSON array of {date, count} for the last 30 days
-- (oldest first), produced inside SQL so the Node side never iterates.

create or replace function public.get_agents_deployed_stats(
  p_with_series boolean default false,
  p_with_first_deploy boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_live_total bigint;
  v_archive_total bigint;
  v_last_24h bigint;
  v_last_7d bigint;
  v_series jsonb;
  v_first_active timestamptz;
  v_first_archive timestamptz;
  v_first_deploy timestamptz;
  v_result jsonb;
begin
  select count(*) into v_live_total
  from public.hermes_instances
  where first_active_at is not null;

  select count(*) into v_archive_total
  from public.instance_deletion_archives;

  select count(*) into v_last_24h
  from public.hermes_instances
  where first_active_at > v_now - interval '24 hours';

  select count(*) into v_last_7d
  from public.hermes_instances
  where first_active_at > v_now - interval '7 days';

  v_result := jsonb_build_object(
    'total', v_live_total + v_archive_total,
    'last24h', v_last_24h,
    'last7d', v_last_7d,
    'generatedAt', v_now
  );

  if p_with_series then
    -- 30 daily buckets, oldest first. generate_series so days with
    -- zero deploys still appear (otherwise the sparkline has gaps).
    select coalesce(jsonb_agg(
      jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'count', n)
      order by day
    ), '[]'::jsonb)
    into v_series
    from (
      select
        d::date as day,
        coalesce((
          select count(*)
          from public.hermes_instances
          where first_active_at >= d
            and first_active_at < d + interval '1 day'
        ), 0) as n
      from generate_series(
        date_trunc('day', v_now - interval '29 days'),
        date_trunc('day', v_now),
        interval '1 day'
      ) as d
    ) as buckets;
    v_result := v_result || jsonb_build_object('series', v_series);
  end if;

  if p_with_first_deploy then
    select min(first_active_at) into v_first_active
    from public.hermes_instances;

    -- Archive rows pre-date their archive row creation; the original
    -- instance created_at lives inside the archive jsonb. Some entries
    -- may be malformed; coalesce safely.
    select min((archive ->> 'created_at')::timestamptz) into v_first_archive
    from public.instance_deletion_archives
    where archive ? 'created_at';

    v_first_deploy := least(v_first_active, v_first_archive);
    v_result := v_result || jsonb_build_object(
      'firstDeployAt', v_first_deploy
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.get_agents_deployed_stats(boolean, boolean) from public;
revoke all on function public.get_agents_deployed_stats(boolean, boolean) from anon, authenticated;
grant execute on function public.get_agents_deployed_stats(boolean, boolean) to service_role;

comment on function public.get_agents_deployed_stats(boolean, boolean) is
  'Marketing /stats counter. One round trip; counts derived from '
  'hermes_instances.first_active_at (monotonic by construction) + '
  'instance_deletion_archives. service_role only.';
