-- Usage and cost groundwork: which agents are actually used, and what servers cost.
--
-- WHY
-- Hivra could not answer two questions: how many hours each agent is actually in
-- use, and what each server costs. Both are needed to see real margins per plan
-- and per agent. This adds only records and a read-only view; nothing is billed,
-- paid or switched on by it.
--
-- 1. hivra_host_costs: what each server costs per month, entered by an operator.
--    A new row with a later effective_from replaces the previous price.
-- 2. Managed inference keys remember their agent. Each managed agent bills through
--    its own proxy key, but the link lived only in hivra_agents.llm_config, which is
--    cleared when the agent is deleted. A trigger now copies the agent id into the
--    key's metadata (agentId) whenever an agent's llm_config names a key, and the
--    existing links are backfilled. Keys made outside an agent (the billing page's
--    own keys) have no agentId.
-- 3. hivra_agent_active_hours: one row per agent per hour in which the agent did
--    something Hivra can see: a managed inference request through its key, or a run
--    event from the run reporter (Claude Code and Codex on Hivra servers). Agents on
--    the owner's own model key with no run reporter are not visible here yet.
--
-- Additive and idempotent. Service role only.

create table if not exists public.hivra_host_costs (
  id                 uuid primary key default gen_random_uuid(),
  host_id            text not null check (btrim(host_id) <> ''),
  provider           text not null default 'hetzner' check (btrim(provider) <> ''),
  monthly_cost_minor integer not null check (monthly_cost_minor >= 0),
  currency           text not null default 'EUR' check (currency in ('EUR', 'USD', 'GBP')),
  effective_from     date not null default current_date,
  note               text,
  created_at         timestamptz not null default now(),
  unique (host_id, effective_from)
);

alter table public.hivra_host_costs enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_host_costs from anon, authenticated;

comment on table public.hivra_host_costs is
  'What each server costs per month (minor units), entered by an operator. The row with the latest effective_from on or before a date is the price on that date.';

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
       set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('agentId', new.id::text)
     where id = key_id
       and user_id = new.user_id
       and coalesce(metadata->>'agentId', '') <> new.id::text;
  exception when others then
    raise warning 'hivra_stamp_agent_on_inference_key: % (agent %)', sqlerrm, new.id;
  end;
  return new;
end;
$$;

revoke all on function public.hivra_stamp_agent_on_inference_key() from public, anon, authenticated;

drop trigger if exists hivra_agents_stamp_inference_key on public.hivra_agents;
create trigger hivra_agents_stamp_inference_key
  after insert or update of llm_config on public.hivra_agents
  for each row execute function public.hivra_stamp_agent_on_inference_key();

-- Backfill the links that still exist.
update public.managed_venice_proxy_keys k
   set metadata = coalesce(k.metadata, '{}'::jsonb) || jsonb_build_object('agentId', a.id::text)
  from public.hivra_agents a
 where jsonb_typeof(a.llm_config) = 'object'
   and a.llm_config->>'proxyKeyId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   and k.id = (a.llm_config->>'proxyKeyId')::uuid
   and k.user_id = a.user_id
   and k.metadata->>'agentId' is null;

create or replace view public.hivra_agent_active_hours
with (security_invoker = true)
as
with inference as (
  select (k.metadata->>'agentId')::uuid as agent_id,
         e.user_id,
         date_trunc('hour', e.created_at) as hour,
         count(*)::integer as inference_requests,
         coalesce(sum(e.charged_micro_usd), 0)::bigint as inference_charged_micro_usd,
         coalesce(sum(e.actual_cost_micro_usd), 0)::bigint as inference_cost_micro_usd
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
         count(*)::integer as run_events
    from public.hivra_agent_events ev
   where ev.event = 'otel_log'
   group by 1, 2, 3
)
select coalesce(i.agent_id, r.agent_id) as agent_id,
       coalesce(i.user_id, r.user_id) as user_id,
       a.type as agent_type,
       coalesce(i.hour, r.hour) as hour,
       coalesce(i.inference_requests, 0) as inference_requests,
       coalesce(i.inference_charged_micro_usd, 0) as inference_charged_micro_usd,
       coalesce(i.inference_cost_micro_usd, 0) as inference_cost_micro_usd,
       coalesce(r.run_events, 0) as run_events
  from inference i
  full join runs r on r.agent_id = i.agent_id and r.hour = i.hour
  left join public.hivra_agents a on a.id = coalesce(i.agent_id, r.agent_id);

revoke all on public.hivra_agent_active_hours from anon, authenticated;

comment on view public.hivra_agent_active_hours is
  'One row per agent per hour in which Hivra saw it work: managed inference through its key, or run events. Read-only; feeds usage and margin reports.';
