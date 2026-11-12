-- Usage by person and agent type, for a read-only usage and margins report.
--
-- WHY
-- The usage records from 20261112230000 answer "which agent worked in which hour".
-- An operator report also needs it summed per person and per agent type for a
-- month, without pulling every hour over the API, and it must still know the type
-- of an agent that was deleted since. This adds only records and a read-only
-- function; nothing is billed, paid or switched on by it.
--
-- 1. Managed inference keys also remember their agent's type (agentType), next to
--    agentId, so usage keeps its type after the agent row is gone.
-- 2. hivra_agent_active_hours falls back to that type (and to the type a run
--    event carries) when the agent row no longer exists.
-- 3. hivra_usage_by_user_and_type(from, to): one row per person and agent type
--    with agents, active hours, inference requests, charged and upstream cost.
--    It reads the base tables by time range, so two indexes are added for it.
--
-- Additive and idempotent. Service role only.

create or replace function public.hivra_stamp_agent_on_inference_key()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  key_id uuid;
begin
  if new.llm_config is null or jsonb_typeof(new.llm_config) <> 'object' then
    return new;
  end if;
  begin
    key_id := (new.llm_config->>'proxyKeyId')::uuid;
  exception when others then
    return new;
  end;
  if key_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.llm_config is not distinct from new.llm_config then
    return new;
  end if;
  -- Never block an agent write over bookkeeping.
  begin
    update public.managed_venice_proxy_keys
       set metadata = coalesce(metadata, '{}'::jsonb)
                      || jsonb_build_object('agentId', new.id::text, 'agentType', new.type)
     where id = key_id
       and user_id = new.user_id
       and (metadata->>'agentId' is distinct from new.id::text
            or metadata->>'agentType' is distinct from new.type);
  exception when others then
    raise warning 'hivra_stamp_agent_on_inference_key: % (agent %)', sqlerrm, new.id;
  end;
  return new;
end;
$$;

revoke all on function public.hivra_stamp_agent_on_inference_key() from public, anon, authenticated;

-- Backfill the type for keys whose agent still exists.
update public.managed_venice_proxy_keys k
   set metadata = k.metadata || jsonb_build_object('agentType', a.type)
  from public.hivra_agents a
 where k.metadata->>'agentId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   and a.id = (k.metadata->>'agentId')::uuid
   and a.user_id = k.user_id
   and k.metadata->>'agentType' is distinct from a.type;

create or replace view public.hivra_agent_active_hours
with (security_invoker = true)
as
with inference as (
  select (k.metadata->>'agentId')::uuid as agent_id,
         e.user_id,
         date_trunc('hour', e.created_at) as hour,
         count(*)::integer as inference_requests,
         coalesce(sum(e.charged_micro_usd), 0)::bigint as inference_charged_micro_usd,
         coalesce(sum(e.actual_cost_micro_usd), 0)::bigint as inference_cost_micro_usd,
         max(nullif(k.metadata->>'agentType', '')) as key_agent_type
    from public.managed_venice_usage_events e
    join public.managed_venice_proxy_keys k on k.id = e.proxy_key_id
   where k.metadata->>'agentId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     and e.status <> 'voided'
   group by 1, 2, 3
),
runs as (
  select ev.agent_id,
         ev.user_id,
         date_trunc('hour', ev.created_at) as hour,
         count(*)::integer as run_events,
         max(ev.agent_type) as event_agent_type
    from public.hivra_agent_events ev
   where ev.event = 'otel_log'
   group by 1, 2, 3
)
select coalesce(i.agent_id, r.agent_id) as agent_id,
       coalesce(i.user_id, r.user_id) as user_id,
       coalesce(a.type, i.key_agent_type, r.event_agent_type) as agent_type,
       coalesce(i.hour, r.hour) as hour,
       coalesce(i.inference_requests, 0) as inference_requests,
       coalesce(i.inference_charged_micro_usd, 0) as inference_charged_micro_usd,
       coalesce(i.inference_cost_micro_usd, 0) as inference_cost_micro_usd,
       coalesce(r.run_events, 0) as run_events
  from inference i
  full join runs r on r.agent_id = i.agent_id and r.hour = i.hour
  left join public.hivra_agents a on a.id = coalesce(i.agent_id, r.agent_id);

revoke all on public.hivra_agent_active_hours from anon, authenticated;

create index if not exists managed_venice_usage_events_created_idx
  on public.managed_venice_usage_events (created_at);

create index if not exists hivra_agent_events_run_created_idx
  on public.hivra_agent_events (created_at)
  where event = 'otel_log';

create or replace function public.hivra_usage_by_user_and_type(p_from timestamptz, p_to timestamptz)
returns table (
  user_id text,
  agent_type text,
  agents integer,
  active_hours integer,
  inference_requests bigint,
  inference_charged_micro_usd bigint,
  inference_cost_micro_usd bigint,
  run_events bigint
)
language sql
stable
set search_path = public
as $$
  with inference as (
    select (k.metadata->>'agentId')::uuid as agent_id,
           e.user_id,
           date_trunc('hour', e.created_at) as hour,
           count(*)::bigint as inference_requests,
           coalesce(sum(e.charged_micro_usd), 0)::bigint as charged,
           coalesce(sum(e.actual_cost_micro_usd), 0)::bigint as cost,
           max(nullif(k.metadata->>'agentType', '')) as key_agent_type
      from public.managed_venice_usage_events e
      join public.managed_venice_proxy_keys k on k.id = e.proxy_key_id
     where e.created_at >= p_from
       and e.created_at < p_to
       and e.status <> 'voided'
       and k.metadata->>'agentId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
     group by 1, 2, 3
  ),
  runs as (
    select ev.agent_id,
           ev.user_id,
           date_trunc('hour', ev.created_at) as hour,
           count(*)::bigint as run_events,
           max(ev.agent_type) as event_agent_type
      from public.hivra_agent_events ev
     where ev.event = 'otel_log'
       and ev.agent_id is not null
       and ev.created_at >= p_from
       and ev.created_at < p_to
     group by 1, 2, 3
  ),
  hours as (
    select coalesce(i.agent_id, r.agent_id) as agent_id,
           coalesce(i.user_id, r.user_id) as user_id,
           coalesce(a.type, i.key_agent_type, r.event_agent_type, 'unknown') as agent_type,
           coalesce(i.inference_requests, 0) as inference_requests,
           coalesce(i.charged, 0) as charged,
           coalesce(i.cost, 0) as cost,
           coalesce(r.run_events, 0) as run_events
      from inference i
      full join runs r on r.agent_id = i.agent_id and r.hour = i.hour
      left join public.hivra_agents a on a.id = coalesce(i.agent_id, r.agent_id)
  )
  select h.user_id,
         h.agent_type,
         count(distinct h.agent_id)::integer,
         count(*)::integer,
         coalesce(sum(h.inference_requests), 0)::bigint,
         coalesce(sum(h.charged), 0)::bigint,
         coalesce(sum(h.cost), 0)::bigint,
         coalesce(sum(h.run_events), 0)::bigint
    from hours h
   group by h.user_id, h.agent_type
   order by h.user_id, h.agent_type;
$$;

revoke all on function public.hivra_usage_by_user_and_type(timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.hivra_usage_by_user_and_type(timestamptz, timestamptz) to service_role;

comment on function public.hivra_usage_by_user_and_type(timestamptz, timestamptz) is
  'Usage per person and agent type between two times: agents, active hours, managed inference requests, charged and upstream cost, run events. Read-only; feeds the operator usage and margins report.';
