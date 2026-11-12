-- Measured use for every kind of agent, from what its computer reports.
--
-- WHY
-- Active hours so far come from managed inference and run events, which miss an
-- agent that runs on its owner's own model key. Each computer's connection
-- service already says when the agent's app was last used through it, how many
-- of its connections are open, and whether a reply is being written or a
-- terminal is attached. A sampler stores those answers here: counts and times
-- only, never content. Records and reading only; nothing is billed, paid, put
-- to sleep or switched on by this.
--
-- 1. hivra_agent_activity: the latest reading per agent.
-- 2. hivra_agent_activity_hours: per agent and hour, how many readings there
--    were and in how many the agent was in use. It carries the owner and agent
--    type itself, so it stays true after the agent is deleted.
-- 3. hivra_record_agent_activity(...): stores one reading in both, in one call.
-- 4. hivra_agent_active_hours and hivra_usage_by_user_and_type also count an
--    hour in which a reading found the agent in use.
--
-- Additive and idempotent. Service role only.

create table if not exists public.hivra_agent_activity (
  agent_id          uuid primary key references public.hivra_agents(id) on delete cascade,
  user_id           text not null,
  observed_at       timestamptz not null,
  reachable         boolean not null,
  boot_id           text,
  app_last_used_at  timestamptz,
  last_reply_at     timestamptz,
  last_used_at      timestamptz,
  open_connections  integer check (open_connections is null or open_connections >= 0),
  active_runs       integer check (active_runs is null or active_runs >= 0),
  terminal_attached boolean,
  desktop_attached  boolean,
  next_job_at       timestamptz,
  updated_at        timestamptz not null default now()
);

alter table public.hivra_agent_activity enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_activity from anon, authenticated;

comment on table public.hivra_agent_activity is
  'The latest reading of each agent''s use, from its computer''s connection service. A column the computer did not report is null, never 0. last_used_at is the last moment Hivra knows the agent was used; boot_id, app_last_used_at and last_reply_at are the raw values the next reading is compared with.';

create table if not exists public.hivra_agent_activity_hours (
  agent_id       uuid not null,
  hour           timestamptz not null,
  user_id        text not null,
  agent_type     text not null,
  samples        integer not null default 0 check (samples >= 0),
  active_samples integer not null default 0 check (active_samples >= 0),
  primary key (agent_id, hour)
);

create index if not exists hivra_agent_activity_hours_hour_idx
  on public.hivra_agent_activity_hours (hour);

alter table public.hivra_agent_activity_hours enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_activity_hours from anon, authenticated;

comment on table public.hivra_agent_activity_hours is
  'Per agent and hour: how many readings were taken (samples) and in how many the agent was in use (active_samples). No link to hivra_agents on purpose, so hours remain after an agent is deleted.';

create or replace function public.hivra_record_agent_activity(
  p_agent_id          uuid,
  p_user_id           text,
  p_agent_type        text,
  p_observed_at       timestamptz,
  p_reachable         boolean,
  p_boot_id           text default null,
  p_app_last_used_at  timestamptz default null,
  p_last_reply_at     timestamptz default null,
  p_last_used_at      timestamptz default null,
  p_open_connections  integer default null,
  p_active_runs       integer default null,
  p_terminal_attached boolean default null,
  p_used_hours        timestamptz[] default '{}'
)
returns void
language plpgsql
set search_path = public
as $$
begin
  if p_reachable then
    insert into public.hivra_agent_activity as a (
      agent_id, user_id, observed_at, reachable, boot_id, app_last_used_at, last_reply_at,
      last_used_at, open_connections, active_runs, terminal_attached, updated_at
    ) values (
      p_agent_id, p_user_id, p_observed_at, true, p_boot_id, p_app_last_used_at, p_last_reply_at,
      p_last_used_at, p_open_connections, p_active_runs, p_terminal_attached, now()
    )
    on conflict (agent_id) do update
      set user_id = excluded.user_id,
          observed_at = excluded.observed_at,
          reachable = true,
          boot_id = excluded.boot_id,
          app_last_used_at = excluded.app_last_used_at,
          last_reply_at = excluded.last_reply_at,
          -- The last known use never moves backwards.
          last_used_at = greatest(a.last_used_at, excluded.last_used_at),
          open_connections = excluded.open_connections,
          active_runs = excluded.active_runs,
          terminal_attached = excluded.terminal_attached,
          updated_at = now()
      where a.observed_at <= excluded.observed_at;
    if not found then
      -- A newer reading is already stored; this one arrived late and is dropped.
      return;
    end if;

    insert into public.hivra_agent_activity_hours as h (agent_id, hour, user_id, agent_type, samples, active_samples)
    values (p_agent_id, date_trunc('hour', p_observed_at), p_user_id, p_agent_type, 1, 0)
    on conflict (agent_id, hour) do update set samples = h.samples + 1;

    insert into public.hivra_agent_activity_hours as h (agent_id, hour, user_id, agent_type, samples, active_samples)
    select p_agent_id, used.hour, p_user_id, p_agent_type, 0, 1
      from (select distinct date_trunc('hour', t) as hour from unnest(coalesce(p_used_hours, '{}')) as t where t is not null) used
    on conflict (agent_id, hour) do update set active_samples = h.active_samples + 1;
  else
    -- Unreachable: keep what was last read, note only that this reading failed.
    insert into public.hivra_agent_activity as a (agent_id, user_id, observed_at, reachable, updated_at)
    values (p_agent_id, p_user_id, p_observed_at, false, now())
    on conflict (agent_id) do update
      set observed_at = excluded.observed_at, reachable = false, updated_at = now()
      where a.observed_at <= excluded.observed_at;
  end if;
end;
$$;

revoke all on function public.hivra_record_agent_activity(uuid, text, text, timestamptz, boolean, text, timestamptz, timestamptz, timestamptz, integer, integer, boolean, timestamptz[]) from public, anon, authenticated;
grant execute on function public.hivra_record_agent_activity(uuid, text, text, timestamptz, boolean, text, timestamptz, timestamptz, timestamptz, integer, integer, boolean, timestamptz[]) to service_role;

comment on function public.hivra_record_agent_activity(uuid, text, text, timestamptz, boolean, text, timestamptz, timestamptz, timestamptz, integer, integer, boolean, timestamptz[]) is
  'Stores one reading of an agent''s use: the latest state, one sample in the reading''s hour, and one active sample in each hour of p_used_hours. A reading older than the stored one is dropped.';

-- Same columns as before; an hour now also counts when a reading found the agent in use.
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
),
seen as (
  select s.agent_id, s.user_id, s.hour, s.agent_type as seen_agent_type
    from public.hivra_agent_activity_hours s
   where s.active_samples > 0
),
worked as (
  select coalesce(i.agent_id, r.agent_id) as agent_id,
         coalesce(i.user_id, r.user_id) as user_id,
         coalesce(i.hour, r.hour) as hour,
         i.key_agent_type,
         r.event_agent_type,
         coalesce(i.inference_requests, 0) as inference_requests,
         coalesce(i.inference_charged_micro_usd, 0) as inference_charged_micro_usd,
         coalesce(i.inference_cost_micro_usd, 0) as inference_cost_micro_usd,
         coalesce(r.run_events, 0) as run_events
    from inference i
    full join runs r on r.agent_id = i.agent_id and r.hour = i.hour
)
select coalesce(w.agent_id, s.agent_id) as agent_id,
       coalesce(w.user_id, s.user_id) as user_id,
       coalesce(a.type, w.key_agent_type, w.event_agent_type, s.seen_agent_type) as agent_type,
       coalesce(w.hour, s.hour) as hour,
       coalesce(w.inference_requests, 0) as inference_requests,
       coalesce(w.inference_charged_micro_usd, 0) as inference_charged_micro_usd,
       coalesce(w.inference_cost_micro_usd, 0) as inference_cost_micro_usd,
       coalesce(w.run_events, 0) as run_events
  from worked w
  full join seen s on s.agent_id = w.agent_id and s.hour = w.hour
  left join public.hivra_agents a on a.id = coalesce(w.agent_id, s.agent_id);

revoke all on public.hivra_agent_active_hours from anon, authenticated;

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
  seen as (
    select s.agent_id, s.user_id, s.hour, s.agent_type as seen_agent_type
      from public.hivra_agent_activity_hours s
     where s.active_samples > 0
       and s.hour >= p_from
       and s.hour < p_to
  ),
  worked as (
    select coalesce(i.agent_id, r.agent_id) as agent_id,
           coalesce(i.user_id, r.user_id) as user_id,
           coalesce(i.hour, r.hour) as hour,
           i.key_agent_type,
           r.event_agent_type,
           coalesce(i.inference_requests, 0) as inference_requests,
           coalesce(i.charged, 0) as charged,
           coalesce(i.cost, 0) as cost,
           coalesce(r.run_events, 0) as run_events
      from inference i
      full join runs r on r.agent_id = i.agent_id and r.hour = i.hour
  ),
  hours as (
    select coalesce(w.agent_id, s.agent_id) as agent_id,
           coalesce(w.user_id, s.user_id) as user_id,
           coalesce(a.type, w.key_agent_type, w.event_agent_type, s.seen_agent_type, 'unknown') as agent_type,
           coalesce(w.inference_requests, 0) as inference_requests,
           coalesce(w.charged, 0) as charged,
           coalesce(w.cost, 0) as cost,
           coalesce(w.run_events, 0) as run_events
      from worked w
      full join seen s on s.agent_id = w.agent_id and s.hour = w.hour
      left join public.hivra_agents a on a.id = coalesce(w.agent_id, s.agent_id)
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
  'Usage per person and agent type between two times: agents, active hours (managed inference, run events, or a reading that found the agent in use), managed inference requests, charged and upstream cost, run events. Read-only; feeds the operator usage and margins report.';
