-- Real country/geo source for the stats system.
--
-- signup_risk_assessments only ever held a sliver of signups (≈3 rows), so the
-- "Countries" counter was a near-empty-table artifact. Clerk is the real source:
-- each user's latest session carries an IP-geo country. The sync-user-geo cron
-- pulls + normalizes those to ISO-2 codes and upserts the aggregate here; the
-- public + admin stats read from this singleton instead of signup_risk_assessments.

create table if not exists public.platform_geo (
  id int primary key default 1,
  country_distribution jsonb not null default '{}'::jsonb,  -- { ISO2: user_count }
  distinct_countries int not null default 0,
  users_with_geo int not null default 0,
  generated_at timestamptz not null default now(),
  constraint platform_geo_singleton check (id = 1)
);

alter table public.platform_geo enable row level security;
-- No policies: service_role + SECURITY DEFINER functions only (not exposed to anon).

-- Repoint the PUBLIC counter: countries now = distinct ISO-2 codes from Clerk geo.
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
    'agentsDeployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + (select count(*) from public.instance_deletion_archives),
    'runningNow',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    'builders',
      (select count(*) from (
          select user_id from public.hermes_instances where user_id is not null
          union
          select user_id from public.signup_risk_assessments where user_id is not null
          union
          select user_id from public.instance_deletion_archives where user_id is not null
        ) u),
    'tokensProcessed',
      coalesce((select sum(tokens_total) from public.platform_stats_daily), 0),
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
      (select count(*) from public.hermes_instances
         where first_active_at > v_now - interval '7 days')
  );
  return v_result;
end;
$$;

revoke all on function public.get_public_stats() from public;
revoke all on function public.get_public_stats() from anon, authenticated;
grant execute on function public.get_public_stats() to service_role;

-- Repoint the daily snapshot's country_distribution to the Clerk-sourced aggregate
-- (was signup_risk_assessments). Everything else identical to the runtime-primary
-- full-throughput rollup.
create or replace function public.compute_platform_stats_snapshot(
  p_date date default (now() at time zone 'utc')::date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  d_start timestamptz := (p_date::timestamp);
  d_end   timestamptz := ((p_date + 1)::timestamp);
  v_result jsonb;
begin
  with live_inst as (
    select id, user_id, resource_tier, provider, backend, product_surface
    from public.hermes_instances
    where lifecycle_state is distinct from 'deleted'
  ),
  activity as (
    select user_id, created_at as ts
    from public.managed_venice_usage_events
    where created_at >= d_end - interval '30 days' and created_at < d_end
      and status is distinct from 'voided' and user_id is not null
    union all
    select user_id, created_at
    from public.llm_usage_events
    where created_at >= d_end - interval '30 days' and created_at < d_end
      and status is distinct from 'voided' and user_id is not null
    union all
    select c.user_id, m.created_at
    from public.hermes_messages m
    join public.hermes_conversations c on c.id = m.conversation_id
    where m.created_at >= d_end - interval '30 days' and m.created_at < d_end
      and c.user_id is not null
  ),
  latest_metric as (
    select distinct on (instance_id) instance_id, ram_peak_bytes, disk_used_bytes
    from public.instance_metering_events
    where sampled_at >= now() - interval '2 hours'
    order by instance_id, sampled_at desc
  ),
  runtime_day as (
    select * from public.instance_usage_snapshots where stat_date = p_date
  )
  insert into public.platform_stats_daily as t (
    stat_date, generated_at,
    total_agents_deployed, total_users,
    new_agents, new_signups, deleted_agents, active_users,
    conversations_started, messages, inference_requests,
    tokens_in, tokens_out, tokens_total, inference_cost_micro_usd, chat_seconds,
    active_agents, paid_users, wau, mau, fleet_ram_bytes, fleet_disk_bytes,
    model_distribution, provider_distribution, tier_distribution,
    country_distribution, product_surface_distribution, backend_distribution,
    agent_sessions, api_calls
  )
  select
    p_date,
    now(),
    (select count(*) from public.hermes_instances where first_active_at is not null and first_active_at < d_end)
      + (select count(*) from public.instance_deletion_archives where created_at < d_end),
    (select count(*) from (
        select user_id from public.hermes_instances where created_at < d_end and user_id is not null
        union
        select user_id from public.signup_risk_assessments where created_at < d_end and user_id is not null
        union
        select user_id from public.instance_deletion_archives where created_at < d_end and user_id is not null
      ) uu),
    (select count(*) from public.hermes_instances where first_active_at >= d_start and first_active_at < d_end),
    (select count(*) from public.signup_risk_assessments where created_at >= d_start and created_at < d_end),
    (select count(*) from public.instance_deletion_archives where created_at >= d_start and created_at < d_end),
    (select count(distinct user_id) from activity where ts >= d_start),
    (select count(*) from public.hermes_conversations where created_at >= d_start and created_at < d_end),
    (select count(*) from public.hermes_messages where created_at >= d_start and created_at < d_end),
    coalesce((select sum(api_calls) from runtime_day), 0),
    coalesce((select sum(input_tokens) from runtime_day), 0),
    coalesce((select sum(output_tokens) from runtime_day), 0),
    coalesce((select sum(total_tokens + coalesce(cache_read_tokens, 0) + coalesce(reasoning_tokens, 0)) from runtime_day), 0),
    coalesce((select sum(coalesce(charged_micro_usd, 0)) from public.managed_venice_usage_events
              where created_at >= d_start and created_at < d_end and status is distinct from 'voided'), 0),
    coalesce((select sum(seconds_used) from public.vm_response_seconds_daily where billing_day = p_date), 0),
    (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    (select count(distinct user_id) from live_inst
       where resource_tier is not null and resource_tier <> 'credit_base' and user_id is not null),
    (select count(distinct user_id) from activity where ts >= d_end - interval '7 days'),
    (select count(distinct user_id) from activity),
    coalesce((select sum(lm.ram_peak_bytes) from latest_metric lm
              join public.hermes_instances i on i.id = lm.instance_id
              where i.lifecycle_state = 'active'), 0),
    coalesce((select sum(lm.disk_used_bytes) from latest_metric lm
              join public.hermes_instances i on i.id = lm.instance_id
              where i.lifecycle_state = 'active'), 0),
    (select coalesce(jsonb_object_agg(model, jsonb_build_object('requests', req, 'tokens', tok)), '{}'::jsonb)
       from (select key as model,
                    sum(coalesce((value->>'requests')::numeric, 0)) as req,
                    sum(coalesce((value->>'tokens')::numeric, 0)) as tok
             from runtime_day ius, jsonb_each(ius.by_model)
             where ius.by_model is not null group by key) z),
    (select coalesce(jsonb_object_agg(provider, jsonb_build_object('requests', req, 'tokens', tok)), '{}'::jsonb)
       from (select key as provider,
                    sum(coalesce((value->>'requests')::numeric, 0)) as req,
                    sum(coalesce((value->>'tokens')::numeric, 0)) as tok
             from runtime_day ius, jsonb_each(ius.by_provider)
             where ius.by_provider is not null group by key) z),
    (select coalesce(jsonb_object_agg(tier, cnt), '{}'::jsonb)
       from (select coalesce(resource_tier, 'unknown') as tier, count(*) as cnt from live_inst group by 1) z),
    -- country_distribution now comes from Clerk geo (platform_geo), not signup_risk_assessments
    coalesce((select country_distribution from public.platform_geo where id = 1), '{}'::jsonb),
    (select coalesce(jsonb_object_agg(ps, cnt), '{}'::jsonb)
       from (select coalesce(product_surface, 'unknown') as ps, count(*) as cnt from live_inst group by 1) z),
    (select coalesce(jsonb_object_agg(be, cnt), '{}'::jsonb)
       from (select coalesce(backend, 'unknown') as be, count(*) as cnt from live_inst group by 1) z),
    (select sum(sessions) from runtime_day),
    (select sum(api_calls) from runtime_day)
  on conflict (stat_date) do update set
    generated_at = excluded.generated_at,
    total_agents_deployed = excluded.total_agents_deployed,
    total_users = excluded.total_users,
    new_agents = excluded.new_agents,
    new_signups = excluded.new_signups,
    deleted_agents = excluded.deleted_agents,
    active_users = excluded.active_users,
    conversations_started = excluded.conversations_started,
    messages = excluded.messages,
    inference_requests = excluded.inference_requests,
    tokens_in = excluded.tokens_in,
    tokens_out = excluded.tokens_out,
    tokens_total = excluded.tokens_total,
    inference_cost_micro_usd = excluded.inference_cost_micro_usd,
    chat_seconds = excluded.chat_seconds,
    active_agents = excluded.active_agents,
    paid_users = excluded.paid_users,
    wau = excluded.wau,
    mau = excluded.mau,
    fleet_ram_bytes = excluded.fleet_ram_bytes,
    fleet_disk_bytes = excluded.fleet_disk_bytes,
    model_distribution = excluded.model_distribution,
    provider_distribution = excluded.provider_distribution,
    tier_distribution = excluded.tier_distribution,
    country_distribution = excluded.country_distribution,
    product_surface_distribution = excluded.product_surface_distribution,
    backend_distribution = excluded.backend_distribution,
    agent_sessions = excluded.agent_sessions,
    api_calls = excluded.api_calls;

  select to_jsonb(t) into v_result from public.platform_stats_daily t where t.stat_date = p_date;
  return v_result;
end;
$$;