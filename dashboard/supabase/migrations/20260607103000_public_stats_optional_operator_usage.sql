-- Make get_public_stats compatible with canary databases that do not yet have
-- the operator_usage_* schema recorded locally.
--
-- 20260607100000 intentionally included Hivra agent counts, but it reused the
-- latest local get_public_stats body, which assumes
-- public.operator_usage_tokens_total() and public.operator_usage_snapshots
-- exist. Canary has Hivra tables but its migration history is drifted: some
-- operator-usage migrations are local-only. Keep operator usage when present,
-- but do not let missing operator telemetry break /stats.

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
  v_operator_tokens bigint := 0;
  v_models integer := 0;
  v_providers integer := 0;
  v_result jsonb;
begin
  if to_regprocedure('public.operator_usage_tokens_total()') is not null then
    execute 'select public.operator_usage_tokens_total()' into v_operator_tokens;
  end if;

  if to_regclass('public.operator_usage_snapshots') is not null then
    execute $models$
      select count(distinct model_key) from (
        select key as model_key from public.platform_stats_daily p,
          lateral jsonb_object_keys(p.model_distribution) as keys(key)
        where p.stat_date > $1 and p.model_distribution <> '{}'::jsonb
        union
        select key as model_key from public.operator_usage_snapshots o,
          lateral jsonb_object_keys(o.by_model) as keys(key)
        where o.stat_date > $1 and o.by_model <> '{}'::jsonb
      ) models
    $models$ into v_models using v_cut90;

    execute $providers$
      select count(distinct provider_key) from (
        select key as provider_key from public.platform_stats_daily p,
          lateral jsonb_object_keys(p.provider_distribution) as keys(key)
        where p.stat_date > $1 and p.provider_distribution <> '{}'::jsonb
        union
        select key as provider_key from public.operator_usage_snapshots o,
          lateral jsonb_object_keys(o.by_provider) as keys(key)
        where o.stat_date > $1 and o.by_provider <> '{}'::jsonb
      ) providers
    $providers$ into v_providers using v_cut90;
  else
    select count(distinct k) into v_models
    from public.platform_stats_daily p,
      lateral jsonb_object_keys(p.model_distribution) k
    where p.stat_date > v_cut90
      and p.model_distribution <> '{}'::jsonb;

    select count(distinct k) into v_providers
    from public.platform_stats_daily p,
      lateral jsonb_object_keys(p.provider_distribution) k
    where p.stat_date > v_cut90
      and p.provider_distribution <> '{}'::jsonb;
  end if;

  v_result := jsonb_build_object(
    'generatedAt', v_now,
    'agentsDeployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + public.hivra_agents_deployed_before(null)
      + (select count(*) from public.instance_deletion_archives),
    'runningNow',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active')
      + public.hivra_agents_running_now(),
    'builders',
      coalesce((select total_users from public.platform_geo where id = 1), 0),
    'tokensProcessed',
      coalesce((select sum(tokens_total) from public.platform_stats_daily), 0) + v_operator_tokens,
    'tokensAnchorPrev', (select tokens_anchor_prev from public.platform_geo where id = 1),
    'tokensAnchorPrevAt', (select tokens_anchor_prev_at from public.platform_geo where id = 1),
    'tokensAnchorCurr', (select tokens_anchor_curr from public.platform_geo where id = 1),
    'tokensAnchorCurrAt', (select tokens_anchor_curr_at from public.platform_geo where id = 1),
    'countries',
      coalesce((select distinct_countries from public.platform_geo where id = 1), 0),
    'models',
      coalesce(v_models, 0),
    'providers',
      coalesce(v_providers, 0),
    'last7dDeployed',
      (select count(*) from public.hermes_instances where first_active_at > v_now - interval '7 days')
      + public.hivra_agents_deployed_between(v_now - interval '7 days', v_now)
  );

  return v_result;
end;
$$;

revoke all on function public.get_public_stats() from public;
revoke all on function public.get_public_stats() from anon, authenticated;
grant execute on function public.get_public_stats() to service_role;

comment on function public.get_public_stats() is
  'Public marketing /stats counters. Includes Hivra agents. Operator usage is included when the operator_usage schema exists and skipped otherwise.';
