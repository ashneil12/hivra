-- platform_stats_daily — internal analytics rollup behind the admin
-- insights dashboard. One row per UTC date capturing platform-wide
-- growth, usage, model/provider mix, tier/geo distribution, and fleet
-- footprint. This is the permanent historical record: the daily cron
-- appends one row and never deletes, so trends survive raw-row cleanup.
--
-- Two metric kinds live here:
--   * day-delta  (new_agents, tokens, messages, ...) — derived from
--     immutable event rows scoped to [date, date+1) in UTC. Accurate
--     even when backfilled for a past date.
--   * point-in-time (active_agents, tier/provider mix, fleet footprint)
--     — captured "as of" the snapshot run. Accurate going forward; a
--     backfill of a past date records *current* point-in-time values
--     (acceptable: those metrics aren't reconstructable from history).
--
-- Privacy: only counts and coarse distributions are stored — never a
-- Clerk user_id, email, IP, or message content. Safe to surface in an
-- investor/partner deck.
--
-- Filled by compute_platform_stats_snapshot(date); read in one round
-- trip by get_platform_stats(days). service_role only — the admin
-- dashboard calls these through the Supabase admin client. The harvest
-- columns (agent_sessions ... byo_model_distribution) are populated by
-- the Phase 2 runtime-usage rollup and stay null until then.

create table if not exists public.platform_stats_daily (
  stat_date date primary key,
  generated_at timestamptz not null default now(),

  -- cumulative as-of end-of-date (reconstructable; backfill-accurate)
  total_agents_deployed bigint not null default 0,
  total_users bigint not null default 0,

  -- day deltas (date-scoped; backfill-accurate)
  new_agents bigint not null default 0,
  new_signups bigint not null default 0,
  deleted_agents bigint not null default 0,
  active_users bigint not null default 0,
  conversations_started bigint not null default 0,
  messages bigint not null default 0,
  inference_requests bigint not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  tokens_total bigint not null default 0,
  inference_cost_micro_usd bigint not null default 0,
  chat_seconds double precision not null default 0,

  -- point-in-time (as-of run; forward-accurate)
  active_agents bigint not null default 0,
  paid_users bigint not null default 0,
  wau bigint not null default 0,
  mau bigint not null default 0,
  fleet_ram_bytes bigint not null default 0,
  fleet_disk_bytes bigint not null default 0,

  -- distributions (label -> count or {requests, tokens})
  model_distribution jsonb not null default '{}'::jsonb,
  provider_distribution jsonb not null default '{}'::jsonb,
  tier_distribution jsonb not null default '{}'::jsonb,
  country_distribution jsonb not null default '{}'::jsonb,
  product_surface_distribution jsonb not null default '{}'::jsonb,
  backend_distribution jsonb not null default '{}'::jsonb,

  -- Phase 2 runtime harvest (nullable until the harvest rollup runs)
  agent_sessions bigint,
  api_calls bigint,
  tool_calls bigint,
  skills_distribution jsonb,
  byo_model_distribution jsonb
);

comment on table public.platform_stats_daily is
  'Daily platform-wide analytics rollup (growth, usage, model/provider mix, tiers, geo, fleet footprint). Append-only historical record. No PII — counts and distributions only. service_role only.';

----------------------------------------------------------------------
-- compute_platform_stats_snapshot(date) — aggregate one UTC day and
-- upsert its row. Idempotent: safe to re-run for today (refreshes) or
-- backfill a past date (day-deltas accurate; point-in-time = now).
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
    country_distribution, product_surface_distribution, backend_distribution
  )
  select
    p_date,
    now(),
    -- total_agents_deployed (cumulative, monotonic — mirrors get_agents_deployed_stats)
    (select count(*) from public.hermes_instances where first_active_at is not null and first_active_at < d_end)
      + (select count(*) from public.instance_deletion_archives where created_at < d_end),
    -- total_users (cumulative distinct across instances + signups + archives)
    (select count(*) from (
        select user_id from public.hermes_instances where created_at < d_end and user_id is not null
        union
        select user_id from public.signup_risk_assessments where created_at < d_end and user_id is not null
        union
        select user_id from public.instance_deletion_archives where created_at < d_end and user_id is not null
      ) uu),
    -- new_agents
    (select count(*) from public.hermes_instances where first_active_at >= d_start and first_active_at < d_end),
    -- new_signups
    (select count(*) from public.signup_risk_assessments where created_at >= d_start and created_at < d_end),
    -- deleted_agents
    (select count(*) from public.instance_deletion_archives where created_at >= d_start and created_at < d_end),
    -- active_users (DAU)
    (select count(distinct user_id) from activity where ts >= d_start),
    -- conversations_started
    (select count(*) from public.hermes_conversations where created_at >= d_start and created_at < d_end),
    -- messages
    (select count(*) from public.hermes_messages where created_at >= d_start and created_at < d_end),
    -- inference_requests
    (select count(*) from usage_day),
    -- tokens_in / tokens_out / tokens_total
    coalesce((select sum(prompt_tokens) from usage_day), 0),
    coalesce((select sum(completion_tokens) from usage_day), 0),
    coalesce((select sum(total_tokens) from usage_day), 0),
    -- inference_cost_micro_usd
    coalesce((select sum(cost_micro_usd) from usage_day), 0),
    -- chat_seconds
    coalesce((select sum(seconds_used) from public.vm_response_seconds_daily where billing_day = p_date), 0),
    -- active_agents (point-in-time)
    (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    -- paid_users (point-in-time: distinct users with a live non-free-tier agent)
    (select count(distinct user_id) from live_inst
       where resource_tier is not null and resource_tier <> 'credit_base' and user_id is not null),
    -- wau (trailing 7d distinct active users)
    (select count(distinct user_id) from activity where ts >= d_end - interval '7 days'),
    -- mau (trailing 30d distinct active users)
    (select count(distinct user_id) from activity),
    -- fleet_ram_bytes / fleet_disk_bytes (sum of latest sample over active agents)
    coalesce((select sum(lm.ram_peak_bytes) from latest_metric lm
              join public.hermes_instances i on i.id = lm.instance_id
              where i.lifecycle_state = 'active'), 0),
    coalesce((select sum(lm.disk_used_bytes) from latest_metric lm
              join public.hermes_instances i on i.id = lm.instance_id
              where i.lifecycle_state = 'active'), 0),
    -- model_distribution (day usage)
    (select coalesce(jsonb_object_agg(model, jsonb_build_object('requests', cnt, 'tokens', tok)), '{}'::jsonb)
       from (select coalesce(model, 'unknown') as model, count(*) as cnt, coalesce(sum(total_tokens), 0) as tok
             from usage_day group by 1) z),
    -- provider_distribution (day usage)
    (select coalesce(jsonb_object_agg(provider, jsonb_build_object('requests', cnt, 'tokens', tok)), '{}'::jsonb)
       from (select coalesce(provider, 'unknown') as provider, count(*) as cnt, coalesce(sum(total_tokens), 0) as tok
             from usage_day group by 1) z),
    -- tier_distribution (point-in-time, live agents by resource_tier)
    (select coalesce(jsonb_object_agg(tier, cnt), '{}'::jsonb)
       from (select coalesce(resource_tier, 'unknown') as tier, count(*) as cnt from live_inst group by 1) z),
    -- country_distribution (cumulative signups by country)
    (select coalesce(jsonb_object_agg(cc, cnt), '{}'::jsonb)
       from (select coalesce(nullif(country_code, ''), '??') as cc, count(*) as cnt
             from public.signup_risk_assessments where created_at < d_end group by 1) z),
    -- product_surface_distribution (point-in-time, live agents)
    (select coalesce(jsonb_object_agg(ps, cnt), '{}'::jsonb)
       from (select coalesce(product_surface, 'unknown') as ps, count(*) as cnt from live_inst group by 1) z),
    -- backend_distribution (point-in-time, live agents)
    (select coalesce(jsonb_object_agg(be, cnt), '{}'::jsonb)
       from (select coalesce(backend, 'unknown') as be, count(*) as cnt from live_inst group by 1) z)
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
    backend_distribution = excluded.backend_distribution;

  select to_jsonb(t) into v_result from public.platform_stats_daily t where t.stat_date = p_date;
  return v_result;
end;
$$;

comment on function public.compute_platform_stats_snapshot(date) is
  'Aggregate one UTC day of platform analytics and upsert into platform_stats_daily. Idempotent; backfill-safe for day-deltas. service_role only.';

----------------------------------------------------------------------
-- get_platform_stats(days) — one round trip for the admin dashboard:
-- the daily series for the window + the latest snapshot + always-fresh
-- live cumulative totals (so headline numbers are current even before
-- today's snapshot has run).
----------------------------------------------------------------------

create or replace function public.get_platform_stats(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 30), 365));
  v_now timestamptz := now();
  v_cutoff date := (v_now at time zone 'utc')::date - v_days;
  v_series jsonb;
  v_latest jsonb;
  v_live jsonb;
begin
  select coalesce(jsonb_agg(to_jsonb(s) order by s.stat_date), '[]'::jsonb)
  into v_series
  from (select * from public.platform_stats_daily where stat_date > v_cutoff) s;

  select to_jsonb(s) into v_latest
  from public.platform_stats_daily s
  order by s.stat_date desc
  limit 1;

  v_live := jsonb_build_object(
    'total_agents_deployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + (select count(*) from public.instance_deletion_archives),
    'active_agents',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active'),
    'live_instances',
      (select count(*) from public.hermes_instances where lifecycle_state is distinct from 'deleted'),
    'total_users',
      (select count(*) from (
          select user_id from public.hermes_instances where user_id is not null
          union
          select user_id from public.signup_risk_assessments where user_id is not null
          union
          select user_id from public.instance_deletion_archives where user_id is not null
        ) uu)
  );

  return jsonb_build_object(
    'generatedAt', v_now,
    'rangeDays', v_days,
    'series', v_series,
    'latest', coalesce(v_latest, '{}'::jsonb),
    'liveTotals', v_live
  );
end;
$$;

comment on function public.get_platform_stats(integer) is
  'Admin insights dashboard read path. Returns daily series + latest snapshot + live cumulative totals as one jsonb blob. service_role only.';

----------------------------------------------------------------------
-- Lock down: service_role only (dashboard uses the admin client).
----------------------------------------------------------------------

alter table public.platform_stats_daily enable row level security;

drop policy if exists "service role manages platform_stats_daily" on public.platform_stats_daily;
create policy "service role manages platform_stats_daily"
  on public.platform_stats_daily
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.platform_stats_daily from anon, authenticated;

revoke all on function public.compute_platform_stats_snapshot(date) from public;
revoke all on function public.compute_platform_stats_snapshot(date) from anon, authenticated;
grant execute on function public.compute_platform_stats_snapshot(date) to service_role;

revoke all on function public.get_platform_stats(integer) from public;
revoke all on function public.get_platform_stats(integer) from anon, authenticated;
grant execute on function public.get_platform_stats(integer) to service_role;
