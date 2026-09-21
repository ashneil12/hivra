-- instance_usage_snapshots — per-instance, per-UTC-day runtime usage
-- harvested from each agent's own /api/analytics/usage endpoint (reached
-- over the Proxmox SSH guest-hop; the agent web server binds loopback
-- only). This is the ONLY token/model source for BYO-key agents, whose
-- inference never flows through the dashboard's managed proxy.
--
-- One row per (instance_id, stat_date). The harvest cron upserts the
-- per-day scalar counters (exact, since the agent groups by UTC day) and
-- attaches the recent model mix + skills usage to the latest day's row.
-- compute_platform_stats_snapshot() folds these into platform_stats_daily
-- (agent_sessions / api_calls / byo_model_distribution / skills_distribution).
--
-- Privacy: counts only — no conversation content, no user id. service_role
-- only.

create table if not exists public.instance_usage_snapshots (
  instance_id uuid not null,
  stat_date date not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  total_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  reasoning_tokens bigint not null default 0,
  estimated_cost_usd numeric not null default 0,
  sessions bigint not null default 0,
  api_calls bigint not null default 0,
  tool_calls bigint,
  by_model jsonb,
  skills jsonb,
  source text not null default 'agent_http',
  harvested_at timestamptz not null default now(),
  primary key (instance_id, stat_date)
);

create index if not exists instance_usage_snapshots_stat_date_idx
  on public.instance_usage_snapshots(stat_date);

comment on table public.instance_usage_snapshots is
  'Per-instance per-UTC-day runtime usage harvested from each agent''s /api/analytics/usage over the SSH guest-hop. Folded into platform_stats_daily. Counts only, service_role only.';

alter table public.instance_usage_snapshots enable row level security;

drop policy if exists "service role manages instance_usage_snapshots" on public.instance_usage_snapshots;
create policy "service role manages instance_usage_snapshots"
  on public.instance_usage_snapshots
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.instance_usage_snapshots from anon, authenticated;

----------------------------------------------------------------------
-- Extend compute_platform_stats_snapshot to fold harvested runtime
-- usage into the daily rollup. Identical to the base definition plus
-- the four harvest columns (agent_sessions, api_calls,
-- skills_distribution, byo_model_distribution) sourced from
-- instance_usage_snapshots for the date. tool_calls stays null (the
-- usage endpoint does not expose a tool-call aggregate).
----------------------------------------------------------------------

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
  with usage_day as (
    select user_id, model, provider,
           coalesce(prompt_tokens, 0)     as prompt_tokens,
           coalesce(completion_tokens, 0) as completion_tokens,
           coalesce(total_tokens, 0)      as total_tokens,
           coalesce(charged_micro_usd, 0) as cost_micro_usd
    from public.managed_venice_usage_events
    where created_at >= d_start and created_at < d_end
      and status is distinct from 'voided'
    union all
    select user_id, model, provider,
           coalesce(prompt_tokens, 0),
           coalesce(completion_tokens, 0),
           coalesce(total_tokens, 0),
           0::bigint
    from public.llm_usage_events
    where created_at >= d_start and created_at < d_end
      and status is distinct from 'voided'
  ),
  live_inst as (
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
    agent_sessions, api_calls, skills_distribution, byo_model_distribution
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
    (select count(*) from usage_day),
    coalesce((select sum(prompt_tokens) from usage_day), 0),
    coalesce((select sum(completion_tokens) from usage_day), 0),
    coalesce((select sum(total_tokens) from usage_day), 0),
    coalesce((select sum(cost_micro_usd) from usage_day), 0),
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
    (select coalesce(jsonb_object_agg(model, jsonb_build_object('requests', cnt, 'tokens', tok)), '{}'::jsonb)
       from (select coalesce(model, 'unknown') as model, count(*) as cnt, coalesce(sum(total_tokens), 0) as tok
             from usage_day group by 1) z),
    (select coalesce(jsonb_object_agg(provider, jsonb_build_object('requests', cnt, 'tokens', tok)), '{}'::jsonb)
       from (select coalesce(provider, 'unknown') as provider, count(*) as cnt, coalesce(sum(total_tokens), 0) as tok
             from usage_day group by 1) z),
    (select coalesce(jsonb_object_agg(tier, cnt), '{}'::jsonb)
       from (select coalesce(resource_tier, 'unknown') as tier, count(*) as cnt from live_inst group by 1) z),
    (select coalesce(jsonb_object_agg(cc, cnt), '{}'::jsonb)
       from (select coalesce(nullif(country_code, ''), '??') as cc, count(*) as cnt
             from public.signup_risk_assessments where created_at < d_end group by 1) z),
    (select coalesce(jsonb_object_agg(ps, cnt), '{}'::jsonb)
       from (select coalesce(product_surface, 'unknown') as ps, count(*) as cnt from live_inst group by 1) z),
    (select coalesce(jsonb_object_agg(be, cnt), '{}'::jsonb)
       from (select coalesce(backend, 'unknown') as be, count(*) as cnt from live_inst group by 1) z),
    -- agent_sessions (harvest fold; null when no runtime data for the day)
    (select sum(sessions) from public.instance_usage_snapshots where stat_date = p_date),
    -- api_calls (harvest fold)
    (select sum(api_calls) from public.instance_usage_snapshots where stat_date = p_date),
    -- skills_distribution (harvest fold; merged across instances)
    (select jsonb_object_agg(skill, cnt) from (
        select key as skill, sum(value::numeric) as cnt
        from public.instance_usage_snapshots ius, jsonb_each_text(ius.skills)
        where ius.stat_date = p_date and ius.skills is not null
        group by key
      ) z),
    -- byo_model_distribution (harvest fold; merged across instances)
    (select jsonb_object_agg(model, jsonb_build_object('requests', req, 'tokens', tok)) from (
        select key as model,
               sum(coalesce((value->>'requests')::numeric, 0)) as req,
               sum(coalesce((value->>'tokens')::numeric, 0)) as tok
        from public.instance_usage_snapshots ius, jsonb_each(ius.by_model)
        where ius.stat_date = p_date and ius.by_model is not null
        group by key
      ) z)
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
    api_calls = excluded.api_calls,
    skills_distribution = excluded.skills_distribution,
    byo_model_distribution = excluded.byo_model_distribution;

  select to_jsonb(t) into v_result from public.platform_stats_daily t where t.stat_date = p_date;
  return v_result;
end;
$$;
