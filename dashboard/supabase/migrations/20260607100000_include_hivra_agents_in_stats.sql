-- Include Hivra V1 agents in the public deployed-agent counters.
--
-- Root cause: the landing + /stats counters were still sourced from the older
-- hermes_instances.first_active_at counter after Hivra launches moved into the
-- hivra_agents table. New deployments could work, but the public counter would
-- not move because it never looked at the new table.
--
-- Hivra's durable "successfully launched at least once" marker is
-- provisioned_at. It is set when the host-side provisioner reports a ready box
-- and is preserved across stop/start/restart. For already-running rows from
-- before this stats fix, backfill provisioned_at from created_at so live boxes
-- are not invisible.

update public.hivra_agents
set provisioned_at = coalesce(provisioned_at, created_at)
where provisioned_at is null
  and status in ('running', 'stopped', 'deleted');

create index if not exists hivra_agents_provisioned_at_idx
  on public.hivra_agents (provisioned_at)
  where provisioned_at is not null;

comment on column public.hivra_agents.provisioned_at is
  'When this Hivra agent first successfully provisioned. Used by public stats as '
  'the Hivra equivalent of hermes_instances.first_active_at.';

create or replace function public.hivra_agents_deployed_before(
  p_before timestamptz default null
)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.hivra_agents
  where provisioned_at is not null
    and (p_before is null or provisioned_at < p_before);
$$;

create or replace function public.hivra_agents_deployed_between(
  p_start timestamptz,
  p_end timestamptz
)
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.hivra_agents
  where provisioned_at >= p_start
    and provisioned_at < p_end;
$$;

create or replace function public.hivra_agents_running_now()
returns bigint
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)
  from public.hivra_agents
  where status = 'running';
$$;

revoke all on function public.hivra_agents_deployed_before(timestamptz) from public;
revoke all on function public.hivra_agents_deployed_before(timestamptz) from anon, authenticated;
grant execute on function public.hivra_agents_deployed_before(timestamptz) to service_role;

revoke all on function public.hivra_agents_deployed_between(timestamptz, timestamptz) from public;
revoke all on function public.hivra_agents_deployed_between(timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.hivra_agents_deployed_between(timestamptz, timestamptz) to service_role;

revoke all on function public.hivra_agents_running_now() from public;
revoke all on function public.hivra_agents_running_now() from anon, authenticated;
grant execute on function public.hivra_agents_running_now() to service_role;

comment on function public.hivra_agents_deployed_before(timestamptz) is
  'Count Hivra agents that successfully provisioned before a cutoff. NULL cutoff means all time.';
comment on function public.hivra_agents_deployed_between(timestamptz, timestamptz) is
  'Count Hivra agents whose first successful provision time falls in a half-open window.';
comment on function public.hivra_agents_running_now() is
  'Live Hivra running-agent gauge for public/admin stats.';

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
  v_hermes_total bigint;
  v_hivra_total bigint;
  v_archive_total bigint;
  v_last_24h bigint;
  v_last_7d bigint;
  v_series jsonb;
  v_first_hermes timestamptz;
  v_first_hivra timestamptz;
  v_first_archive timestamptz;
  v_first_deploy timestamptz;
  v_result jsonb;
begin
  select count(*) into v_hermes_total
  from public.hermes_instances
  where first_active_at is not null;

  v_hivra_total := public.hivra_agents_deployed_before(null);

  select count(*) into v_archive_total
  from public.instance_deletion_archives;

  select
    count(*) + public.hivra_agents_deployed_between(v_now - interval '24 hours', v_now)
  into v_last_24h
  from public.hermes_instances
  where first_active_at > v_now - interval '24 hours';

  select
    count(*) + public.hivra_agents_deployed_between(v_now - interval '7 days', v_now)
  into v_last_7d
  from public.hermes_instances
  where first_active_at > v_now - interval '7 days';

  v_result := jsonb_build_object(
    'total', v_hermes_total + v_hivra_total + v_archive_total,
    'last24h', v_last_24h,
    'last7d', v_last_7d,
    'generatedAt', v_now,
    'sourceCounts', jsonb_build_object(
      'hermesInstances', v_hermes_total,
      'hivraAgents', v_hivra_total,
      'archivedInstances', v_archive_total
    )
  );

  if p_with_series then
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
        ), 0)
        + public.hivra_agents_deployed_between(d, d + interval '1 day') as n
      from generate_series(
        date_trunc('day', v_now - interval '29 days'),
        date_trunc('day', v_now),
        interval '1 day'
      ) as d
    ) as buckets;
    v_result := v_result || jsonb_build_object('series', v_series);
  end if;

  if p_with_first_deploy then
    select min(first_active_at) into v_first_hermes
    from public.hermes_instances;

    select min(provisioned_at) into v_first_hivra
    from public.hivra_agents
    where provisioned_at is not null;

    select min((archive ->> 'created_at')::timestamptz) into v_first_archive
    from public.instance_deletion_archives
    where archive ? 'created_at';

    v_first_deploy := least(v_first_hermes, v_first_hivra, v_first_archive);
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
  'Marketing /stats counter. Counts successful Hermes instances + successful Hivra agents + archived Hermes instances in one RPC. service_role only.';

create or replace function public.get_public_stats()
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_cut90 date := (v_now at time zone 'utc')::date - 90;
  v_operator_tokens bigint := public.operator_usage_tokens_total();
  v_result jsonb;
begin
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
      (
        select count(distinct model_key) from (
          select key as model_key from public.platform_stats_daily p,
            lateral jsonb_object_keys(p.model_distribution) as keys(key)
          where p.stat_date > v_cut90 and p.model_distribution <> '{}'::jsonb
          union
          select key as model_key from public.operator_usage_snapshots o,
            lateral jsonb_object_keys(o.by_model) as keys(key)
          where o.stat_date > v_cut90 and o.by_model <> '{}'::jsonb
        ) models
      ),
    'providers',
      (
        select count(distinct provider_key) from (
          select key as provider_key from public.platform_stats_daily p,
            lateral jsonb_object_keys(p.provider_distribution) as keys(key)
          where p.stat_date > v_cut90 and p.provider_distribution <> '{}'::jsonb
          union
          select key as provider_key from public.operator_usage_snapshots o,
            lateral jsonb_object_keys(o.by_provider) as keys(key)
          where o.stat_date > v_cut90 and o.by_provider <> '{}'::jsonb
        ) providers
      ),
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

create or replace function public.get_platform_stats(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
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
  from public.platform_stats_daily s order by s.stat_date desc limit 1;

  v_live := jsonb_build_object(
    'total_agents_deployed',
      (select count(*) from public.hermes_instances where first_active_at is not null)
      + public.hivra_agents_deployed_before(null)
      + (select count(*) from public.instance_deletion_archives),
    'active_agents',
      (select count(*) from public.hermes_instances where lifecycle_state = 'active')
      + public.hivra_agents_running_now(),
    'live_instances',
      (select count(*) from public.hermes_instances where lifecycle_state is distinct from 'deleted')
      + (select count(*) from public.hivra_agents where status <> 'deleted'),
    'total_users',
      coalesce((select total_users from public.platform_geo where id = 1), 0)
  );

  return jsonb_build_object(
    'generatedAt', v_now, 'rangeDays', v_days,
    'series', v_series, 'latest', coalesce(v_latest, '{}'::jsonb), 'liveTotals', v_live
  );
end;
$$;

create or replace function public.compute_platform_stats_snapshot(
  p_date date default (now() at time zone 'utc')::date
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  d_start timestamptz := (p_date::timestamp);
  d_end   timestamptz := ((p_date + 1)::timestamp);
  v_result jsonb;
begin
  with live_inst as (
    select id, user_id, resource_tier, provider, backend, product_surface
    from public.hermes_instances where lifecycle_state is distinct from 'deleted'
  ),
  activity as (
    select user_id, created_at as ts from public.managed_venice_usage_events
    where created_at >= d_end - interval '30 days' and created_at < d_end
      and status is distinct from 'voided' and user_id is not null
    union all
    select user_id, created_at from public.llm_usage_events
    where created_at >= d_end - interval '30 days' and created_at < d_end
      and status is distinct from 'voided' and user_id is not null
    union all
    select c.user_id, m.created_at from public.hermes_messages m
    join public.hermes_conversations c on c.id = m.conversation_id
    where m.created_at >= d_end - interval '30 days' and m.created_at < d_end and c.user_id is not null
  ),
  latest_metric as (
    select distinct on (instance_id) instance_id, ram_peak_bytes, disk_used_bytes
    from public.instance_metering_events where sampled_at >= now() - interval '2 hours'
    order by instance_id, sampled_at desc
  ),
  runtime_day as (select * from public.instance_usage_snapshots where stat_date = p_date)
  insert into public.platform_stats_daily as t (
    stat_date, generated_at, total_agents_deployed, total_users,
    new_agents, new_signups, deleted_agents, active_users,
    conversations_started, messages, inference_requests,
    tokens_in, tokens_out, tokens_total, inference_cost_micro_usd, chat_seconds,
    active_agents, paid_users, wau, mau, fleet_ram_bytes, fleet_disk_bytes,
    model_distribution, provider_distribution, tier_distribution,
    country_distribution, product_surface_distribution, backend_distribution,
    agent_sessions, api_calls
  )
  select
    p_date, now(),
    (select count(*) from public.hermes_instances where first_active_at is not null and first_active_at < d_end)
      + public.hivra_agents_deployed_before(d_end)
      + (select count(*) from public.instance_deletion_archives where created_at < d_end),
    coalesce((select sum(e.value::int) from public.platform_geo pg, jsonb_each_text(pg.signups_by_day) e
              where pg.id = 1 and e.key::date <= p_date), 0),
    (select count(*) from public.hermes_instances where first_active_at >= d_start and first_active_at < d_end)
      + public.hivra_agents_deployed_between(d_start, d_end),
    coalesce((select (pg.signups_by_day ->> to_char(p_date, 'YYYY-MM-DD'))::int
              from public.platform_geo pg where pg.id = 1), 0),
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
    (select count(*) from public.hermes_instances where lifecycle_state = 'active')
      + public.hivra_agents_running_now(),
    (select count(distinct user_id) from live_inst where resource_tier is not null and resource_tier <> 'credit_base' and user_id is not null),
    (select count(distinct user_id) from activity where ts >= d_end - interval '7 days'),
    (select count(distinct user_id) from activity),
    coalesce((select sum(lm.ram_peak_bytes) from latest_metric lm join public.hermes_instances i on i.id = lm.instance_id where i.lifecycle_state = 'active'), 0),
    coalesce((select sum(lm.disk_used_bytes) from latest_metric lm join public.hermes_instances i on i.id = lm.instance_id where i.lifecycle_state = 'active'), 0),
    (select coalesce(jsonb_object_agg(model, jsonb_build_object('requests', req, 'tokens', tok)), '{}'::jsonb)
       from (select key as model, sum(coalesce((value->>'requests')::numeric,0)) as req, sum(coalesce((value->>'tokens')::numeric,0)) as tok
             from runtime_day ius, jsonb_each(ius.by_model) where ius.by_model is not null group by key) z),
    (select coalesce(jsonb_object_agg(provider, jsonb_build_object('requests', req, 'tokens', tok)), '{}'::jsonb)
       from (select key as provider, sum(coalesce((value->>'requests')::numeric,0)) as req, sum(coalesce((value->>'tokens')::numeric,0)) as tok
             from runtime_day ius, jsonb_each(ius.by_provider) where ius.by_provider is not null group by key) z),
    (select coalesce(jsonb_object_agg(tier, cnt), '{}'::jsonb)
       from (select coalesce(resource_tier, 'unknown') as tier, count(*) as cnt from live_inst group by 1) z),
    coalesce((select country_distribution from public.platform_geo where id = 1), '{}'::jsonb),
    (select coalesce(jsonb_object_agg(ps, cnt), '{}'::jsonb)
       from (select coalesce(product_surface, 'unknown') as ps, count(*) as cnt from live_inst group by 1) z),
    (select coalesce(jsonb_object_agg(be, cnt), '{}'::jsonb)
       from (select coalesce(backend, 'unknown') as be, count(*) as cnt from live_inst group by 1) z),
    (select sum(sessions) from runtime_day),
    (select sum(api_calls) from runtime_day)
  on conflict (stat_date) do update set
    generated_at = excluded.generated_at, total_agents_deployed = excluded.total_agents_deployed,
    total_users = excluded.total_users, new_agents = excluded.new_agents, new_signups = excluded.new_signups,
    deleted_agents = excluded.deleted_agents, active_users = excluded.active_users,
    conversations_started = excluded.conversations_started, messages = excluded.messages,
    inference_requests = excluded.inference_requests, tokens_in = excluded.tokens_in,
    tokens_out = excluded.tokens_out, tokens_total = excluded.tokens_total,
    inference_cost_micro_usd = excluded.inference_cost_micro_usd, chat_seconds = excluded.chat_seconds,
    active_agents = excluded.active_agents, paid_users = excluded.paid_users, wau = excluded.wau, mau = excluded.mau,
    fleet_ram_bytes = excluded.fleet_ram_bytes, fleet_disk_bytes = excluded.fleet_disk_bytes,
    model_distribution = excluded.model_distribution, provider_distribution = excluded.provider_distribution,
    tier_distribution = excluded.tier_distribution, country_distribution = excluded.country_distribution,
    product_surface_distribution = excluded.product_surface_distribution, backend_distribution = excluded.backend_distribution,
    agent_sessions = excluded.agent_sessions, api_calls = excluded.api_calls;
  select to_jsonb(t) into v_result from public.platform_stats_daily t where t.stat_date = p_date;
  return v_result;
end;
$$;
