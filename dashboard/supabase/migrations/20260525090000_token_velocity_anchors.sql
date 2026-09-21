-- Smooth, deterministic "tokens processed" odometer.
--
-- The real token total only changes hourly (harvest + rollup). To make the
-- public counter climb smoothly *and* identically for every viewer, we store two
-- hourly checkpoints of the cumulative total and let the client linearly play
-- the older→newer delta over a full wall-clock hour: it runs ~1h behind reality,
-- climbing at exactly the last hour's measured token velocity. Pure function of
-- the two checkpoints + the clock ⇒ everyone sees the same number, it never
-- overshoots (always counting toward an already-measured value), and because the
-- next checkpoint lands before the current playback ends it never freezes.
--
-- roll_token_anchor() shifts the pair at most once per clock hour; the hourly
-- rollup cron calls it after recomputing the daily snapshot.

alter table public.platform_geo
  add column if not exists tokens_anchor_prev bigint,
  add column if not exists tokens_anchor_prev_at timestamptz,
  add column if not exists tokens_anchor_curr bigint,
  add column if not exists tokens_anchor_curr_at timestamptz;

create or replace function public.roll_token_anchor()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint := coalesce((select sum(tokens_total) from public.platform_stats_daily), 0);
begin
  update public.platform_geo
  set
    tokens_anchor_prev = tokens_anchor_curr,
    tokens_anchor_prev_at = tokens_anchor_curr_at,
    tokens_anchor_curr = v_total,
    tokens_anchor_curr_at = date_trunc('hour', now())
  where id = 1
    and (tokens_anchor_curr_at is null
         or date_trunc('hour', tokens_anchor_curr_at) < date_trunc('hour', now()));
end;
$$;
revoke all on function public.roll_token_anchor() from public;
revoke all on function public.roll_token_anchor() from anon, authenticated;
grant execute on function public.roll_token_anchor() to service_role;

-- Expose the two checkpoints alongside the live total.
create or replace function public.get_public_stats()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_cut90 date := (v_now at time zone 'utc')::date - 90;
  v_result jsonb;
begin
  v_result := jsonb_build_object(
    'generatedAt', v_now,
    'agentsDeployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + (select count(*) from public.instance_deletion_archives),
    'runningNow',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    'builders',
      coalesce((select total_users from public.platform_geo where id = 1), 0),
    'tokensProcessed',
      coalesce((select sum(tokens_total) from public.platform_stats_daily), 0),
    'tokensAnchorPrev', (select tokens_anchor_prev from public.platform_geo where id = 1),
    'tokensAnchorPrevAt', (select tokens_anchor_prev_at from public.platform_geo where id = 1),
    'tokensAnchorCurr', (select tokens_anchor_curr from public.platform_geo where id = 1),
    'tokensAnchorCurrAt', (select tokens_anchor_curr_at from public.platform_geo where id = 1),
    'countries',
      coalesce((select distinct_countries from public.platform_geo where id = 1), 0),
    'models',
      (select count(distinct k) from public.platform_stats_daily p,
         lateral jsonb_object_keys(p.model_distribution) k
       where p.stat_date > v_cut90 and p.model_distribution <> '{}'::jsonb),
    'providers',
      (select count(distinct k) from public.platform_stats_daily p,
         lateral jsonb_object_keys(p.provider_distribution) k
       where p.stat_date > v_cut90 and p.provider_distribution <> '{}'::jsonb),
    'last7dDeployed',
      (select count(*) from public.hermes_instances where first_active_at > v_now - interval '7 days')
  );
  return v_result;
end;
$$;
revoke all on function public.get_public_stats() from public;
revoke all on function public.get_public_stats() from anon, authenticated;
grant execute on function public.get_public_stats() to service_role;
