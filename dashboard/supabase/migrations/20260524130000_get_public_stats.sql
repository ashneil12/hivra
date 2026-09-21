-- get_public_stats() — the PUBLIC marketing /stats counters. Distinct from
-- get_platform_stats (admin): this exposes ONLY vetted, public-safe,
-- impress-only aggregates. No money, no per-user data, no per-model/provider
-- shares — just headline counts. Read server-side via supabaseAdmin (the
-- /stats page + its public polling route); never callable by anon directly.
--
-- Designed to trend UP: agentsDeployed is the monotonic cumulative counter;
-- tokensProcessed sums every day's runtime tokens (grows as the fleet runs +
-- harvest coverage converges); the rest are live/cumulative counts.

create or replace function public.get_public_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_cut90 date := (v_now at time zone 'utc')::date - 90;
  v_result jsonb;
begin
  v_result := jsonb_build_object(
    'generatedAt', v_now,
    -- monotonic cumulative deploy counter (mirrors get_agents_deployed_stats)
    'agentsDeployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + (select count(*) from public.instance_deletion_archives),
    -- live gauge: agents running right now
    'runningNow',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    -- distinct builders (instances + signups + archived owners)
    'builders',
      (select count(*) from (
          select user_id from public.hermes_instances where user_id is not null
          union
          select user_id from public.signup_risk_assessments where user_id is not null
          union
          select user_id from public.instance_deletion_archives where user_id is not null
        ) u),
    -- all-time runtime tokens processed across the fleet
    'tokensProcessed',
      coalesce((select sum(tokens_total) from public.platform_stats_daily), 0),
    -- global reach: distinct signup countries (real codes only)
    'countries',
      (select count(distinct country_code) from public.signup_risk_assessments
         where country_code is not null and btrim(country_code) <> ''),
    -- breadth (last 90d of runtime usage): how many models / providers in play
    'models',
      (select count(distinct k) from public.platform_stats_daily p,
         lateral jsonb_object_keys(p.model_distribution) k
       where p.stat_date > v_cut90 and p.model_distribution <> '{}'::jsonb),
    'providers',
      (select count(distinct k) from public.platform_stats_daily p,
         lateral jsonb_object_keys(p.provider_distribution) k
       where p.stat_date > v_cut90 and p.provider_distribution <> '{}'::jsonb),
    -- momentum
    'last7dDeployed',
      (select count(*) from public.hermes_instances
         where first_active_at > v_now - interval '7 days')
  );
  return v_result;
end;
$$;

comment on function public.get_public_stats() is
  'Public marketing /stats counters — vetted, public-safe aggregates only (counts; no PII, no $, no per-model shares). service_role only; surfaced via the /stats SSR page + its public polling route.';

revoke all on function public.get_public_stats() from public;
revoke all on function public.get_public_stats() from anon, authenticated;
grant execute on function public.get_public_stats() to service_role;
