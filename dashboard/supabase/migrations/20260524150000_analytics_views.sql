-- Analytics consumption layer.
--
-- Flat, BI-friendly daily time series derived from the append-only stat stores
-- (platform_stats_daily + managed_venice_usage_events). These exist so the JSONB
-- distributions become clean rows you can filter on the admin dashboard and pull
-- straight into Power BI / any SQL client without unnesting JSON by hand.
--
-- Aggregate, non-PII only (counts, tokens, cost). security_invoker = true so the
-- caller's RLS on the underlying tables applies; access is revoked from anon /
-- authenticated and granted to service_role (the admin dashboard reads via the
-- service-role client). Re-runnable.

-- Provider mix per UTC day (fleet-wide, runtime-sourced).
create or replace view public.analytics_provider_usage_daily
  with (security_invoker = true) as
select
  p.stat_date,
  d.key as provider,
  coalesce((d.value ->> 'requests')::numeric, 0)::bigint as requests,
  coalesce((d.value ->> 'tokens')::numeric, 0)::bigint as tokens
from public.platform_stats_daily p
cross join lateral jsonb_each(coalesce(p.provider_distribution, '{}'::jsonb)) as d
where p.provider_distribution is not null and p.provider_distribution <> '{}'::jsonb;

-- Model mix per UTC day (fleet-wide, runtime-sourced).
create or replace view public.analytics_model_usage_daily
  with (security_invoker = true) as
select
  p.stat_date,
  d.key as model,
  coalesce((d.value ->> 'requests')::numeric, 0)::bigint as requests,
  coalesce((d.value ->> 'tokens')::numeric, 0)::bigint as tokens
from public.platform_stats_daily p
cross join lateral jsonb_each(coalesce(p.model_distribution, '{}'::jsonb)) as d
where p.model_distribution is not null and p.model_distribution <> '{}'::jsonb;

-- Resource-tier mix per UTC day (point-in-time as of each snapshot run).
create or replace view public.analytics_tier_distribution_daily
  with (security_invoker = true) as
select
  p.stat_date,
  d.key as tier,
  coalesce((d.value #>> '{}')::bigint, 0) as instances
from public.platform_stats_daily p
cross join lateral jsonb_each(coalesce(p.tier_distribution, '{}'::jsonb)) as d;

-- Signup country mix per UTC day (cumulative as of each snapshot run).
create or replace view public.analytics_country_distribution_daily
  with (security_invoker = true) as
select
  p.stat_date,
  d.key as country,
  coalesce((d.value #>> '{}')::bigint, 0) as signups
from public.platform_stats_daily p
cross join lateral jsonb_each(coalesce(p.country_distribution, '{}'::jsonb)) as d;

-- Managed Venice usage per UTC day (its own clean stream: tokens, cost, users).
-- Sourced from the per-event billing log, which is append-only.
create or replace view public.analytics_venice_usage_daily
  with (security_invoker = true) as
select
  (e.created_at at time zone 'utc')::date as stat_date,
  count(*) filter (where e.status is distinct from 'voided') as requests,
  count(distinct e.user_id) filter (where e.status is distinct from 'voided') as users,
  coalesce(sum(e.prompt_tokens) filter (where e.status is distinct from 'voided'), 0)::bigint as prompt_tokens,
  coalesce(sum(e.completion_tokens) filter (where e.status is distinct from 'voided'), 0)::bigint as completion_tokens,
  coalesce(sum(e.total_tokens) filter (where e.status is distinct from 'voided'), 0)::bigint as total_tokens,
  round(coalesce(sum(e.charged_micro_usd) filter (where e.status is distinct from 'voided'), 0) / 1000000.0, 6) as charged_usd,
  round(coalesce(sum(e.actual_cost_micro_usd) filter (where e.status is distinct from 'voided'), 0) / 1000000.0, 6) as actual_cost_usd
from public.managed_venice_usage_events e
group by 1;

-- Flat scalar daily metrics (stable BI surface over platform_stats_daily).
create or replace view public.analytics_platform_daily
  with (security_invoker = true) as
select
  stat_date, generated_at,
  total_agents_deployed, total_users,
  new_agents, new_signups, deleted_agents, active_users,
  conversations_started, messages, inference_requests,
  tokens_in, tokens_out, tokens_total, inference_cost_micro_usd, chat_seconds,
  active_agents, paid_users, wau, mau,
  fleet_ram_bytes, fleet_disk_bytes, agent_sessions, api_calls
from public.platform_stats_daily;

-- Keep the analytics layer internal (admin dashboard uses the service-role client;
-- not exposed via the anon/public API).
do $$
declare v text;
begin
  foreach v in array array[
    'analytics_provider_usage_daily',
    'analytics_model_usage_daily',
    'analytics_tier_distribution_daily',
    'analytics_country_distribution_daily',
    'analytics_venice_usage_daily',
    'analytics_platform_daily'
  ] loop
    execute format('revoke all on public.%I from anon, authenticated', v);
    execute format('grant select on public.%I to service_role', v);
  end loop;
end $$;
