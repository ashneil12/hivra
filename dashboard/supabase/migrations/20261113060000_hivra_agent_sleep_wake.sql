-- Agent sleep and wake, store layer.
--
-- WHY
-- Sleeping an agent (a nap or a hibernate) and waking it are host operations
-- that take time and must not overlap with each other or with any other
-- lifecycle action. They hold the agent's existing operation lease, with two
-- new kinds, sleep and wake. The agent's status stays 'running' for the whole
-- time: a failed sleep or wake must never push an agent into an error state, so
-- NONE of the functions below touches status. The sleep itself is tracked in
-- sleep_state and sleep_generation (added by 20261113020000), and
-- sleep_generation is the compare-and-swap token: a stale sleep request, from
-- a sweep that read the agent before it was touched, loses.
--
-- 1. hivra_agents_operation_shape_check admits the sleep and wake kinds.
-- 2. hivra_agent_sleep_events: one row per sleep, wake, abort or failure, with
--    counts and timings only, never content. Service role only.
-- 3. claim_hivra_agent_sleep, finish_hivra_agent_sleep, claim_hivra_agent_wake
--    and finish_hivra_agent_wake. Service role only.
--
-- Additive and idempotent. The widened constraint is added NOT VALID and then
-- validated in its own statement, so the ACCESS EXCLUSIVE lock is brief and the
-- table scan runs under a weaker lock. Every existing row already satisfies the
-- wider list. lock_timeout makes the migration give up, rather than queue and
-- block the table, if a long transaction holds it.

set local lock_timeout = '2s';

-- 1. Operation kinds ----------------------------------------------------------

alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach',
     'private_access','agent_access_change','agent_detach','runtime_update','sleep','wake')
    and operation_kind is not null and operation_started_at is not null
    and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
) not valid;
alter table public.hivra_agents validate constraint hivra_agents_operation_shape_check;

-- 2. hivra_agent_sleep_events -------------------------------------------------

create table if not exists public.hivra_agent_sleep_events (
  id          bigserial primary key,
  agent_id    uuid not null references public.hivra_agents(id) on delete cascade,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('nap', 'hibernate', 'wake', 'abort', 'fail', 'reconcile')),
  from_state  text,
  to_state    text,
  generation  bigint,
  duration_ms integer,
  trigger     text not null check (trigger in ('sweep', 'manual', 'open', 'action', 'schedule', 'reconcile')),
  reason      text,
  detail      jsonb
);

create index if not exists hivra_agent_sleep_events_agent_at_idx
  on public.hivra_agent_sleep_events using btree (agent_id, at desc);

alter table public.hivra_agent_sleep_events enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_sleep_events from anon, authenticated;
revoke all on sequence public.hivra_agent_sleep_events_id_seq from anon, authenticated;

comment on table public.hivra_agent_sleep_events is
  'One row per sleep, wake, abort, failure or reconcile of an agent. Counts and timings only, never content or secrets.';
comment on column public.hivra_agent_sleep_events.kind is
  'nap, hibernate, wake, abort (a sleep that stood down), fail, or reconcile (a stale lease settled to the observed state).';
comment on column public.hivra_agent_sleep_events.trigger is
  'What started it: sweep, manual, open (the owner opened the agent), action, schedule or reconcile.';
comment on column public.hivra_agent_sleep_events.detail is
  'Step timings in milliseconds and counts. Never secrets.';

-- 3. Lease functions ----------------------------------------------------------

-- Take the agent for a sleep. Returns the new sleep_generation, or null when
-- refused: the agent is not running, is being stopped or deleted, holds another
-- operation, was touched since the caller read it (generation mismatch), or is
-- not in a state this tier can start from.
create or replace function public.claim_hivra_agent_sleep(
  p_agent_id uuid, p_operation_id uuid, p_tier text, p_expected_generation bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype; new_generation bigint;
begin
  if p_agent_id is null or p_operation_id is null or p_expected_generation is null
    or p_tier is null or p_tier not in ('nap', 'hibernate') then return null; end if;
  select * into a from public.hivra_agents where id = p_agent_id for update;
  if not found then return null; end if;
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or a.operation_id is not null
    or a.sleep_generation is distinct from p_expected_generation then return null; end if;
  if p_tier = 'nap' and a.sleep_state is distinct from 'awake' then return null; end if;
  if p_tier = 'hibernate' and a.sleep_state not in ('awake', 'napping') then return null; end if;
  new_generation := a.sleep_generation + 1;
  update public.hivra_agents set
    operation_id = p_operation_id, operation_kind = 'sleep', operation_started_at = clock_timestamp(),
    operation_payload = null,
    sleep_state = case when p_tier = 'nap' then 'draining' else 'hibernating' end,
    sleep_generation = new_generation, sleep_tier_changed_at = clock_timestamp()
  where id = a.id;
  return new_generation;
end;
$$;

-- Release a sleep lease and record where the agent ended up: napping,
-- hibernated, or awake (the sleep stood down or failed safe). A result for a
-- lease the agent no longer holds changes nothing. When the owner has asked for
-- the agent to be deleted meanwhile, only the lease is cleared and the delete
-- worker takes it from there.
create or replace function public.finish_hivra_agent_sleep(
  p_agent_id uuid, p_operation_id uuid, p_result text)
returns boolean language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype;
begin
  if p_agent_id is null or p_operation_id is null
    or p_result is null or p_result not in ('napping', 'hibernated', 'awake') then return false; end if;
  select * into a from public.hivra_agents
    where id = p_agent_id and operation_id = p_operation_id and operation_kind = 'sleep' for update;
  if not found then return false; end if;
  if a.desired_state = 'deleted' then
    update public.hivra_agents set operation_id = null, operation_kind = null,
      operation_started_at = null, operation_payload = null where id = a.id;
    return true;
  end if;
  update public.hivra_agents set operation_id = null, operation_kind = null,
    operation_started_at = null, operation_payload = null,
    sleep_state = p_result, sleep_generation = a.sleep_generation + 1,
    sleep_tier_changed_at = clock_timestamp()
  where id = a.id;
  return true;
end;
$$;

-- Take the agent for a wake. Returns one of:
--   awake    nothing to do
--   busy     another operation holds the agent; the caller waits and looks again
--   claimed  the caller now holds the wake lease and must run the wake
--   refused  the agent is in no state a wake can start from (for example it is
--            mid-sleep without a lease, or is not running)
create or replace function public.claim_hivra_agent_wake(
  p_agent_id uuid, p_operation_id uuid)
returns text language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype;
begin
  if p_agent_id is null or p_operation_id is null then return 'refused'; end if;
  select * into a from public.hivra_agents where id = p_agent_id for update;
  if not found then return 'refused'; end if;
  if a.sleep_state = 'awake' then return 'awake'; end if;
  if a.operation_id is not null then return 'busy'; end if;
  if a.sleep_state in ('napping', 'hibernated', 'wake_failed') and a.status = 'running' then
    update public.hivra_agents set
      operation_id = p_operation_id, operation_kind = 'wake', operation_started_at = clock_timestamp(),
      operation_payload = null,
      sleep_state = 'waking', sleep_generation = a.sleep_generation + 1,
      sleep_tier_changed_at = clock_timestamp()
    where id = a.id;
    return 'claimed';
  end if;
  return 'refused';
end;
$$;

-- Release a wake lease: awake (also clears any scheduled wake) or wake_failed.
-- Mirrors finish_hivra_agent_sleep, including the delete-pending case.
create or replace function public.finish_hivra_agent_wake(
  p_agent_id uuid, p_operation_id uuid, p_result text)
returns boolean language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype;
begin
  if p_agent_id is null or p_operation_id is null
    or p_result is null or p_result not in ('awake', 'wake_failed') then return false; end if;
  select * into a from public.hivra_agents
    where id = p_agent_id and operation_id = p_operation_id and operation_kind = 'wake' for update;
  if not found then return false; end if;
  if a.desired_state = 'deleted' then
    update public.hivra_agents set operation_id = null, operation_kind = null,
      operation_started_at = null, operation_payload = null where id = a.id;
    return true;
  end if;
  update public.hivra_agents set operation_id = null, operation_kind = null,
    operation_started_at = null, operation_payload = null,
    sleep_state = p_result, sleep_generation = a.sleep_generation + 1,
    sleep_tier_changed_at = clock_timestamp(),
    next_wake_at = case when p_result = 'awake' then null else a.next_wake_at end
  where id = a.id;
  return true;
end;
$$;

revoke all on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint) from public, anon, authenticated;
revoke all on function public.finish_hivra_agent_sleep(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_hivra_agent_wake(uuid, uuid) from public, anon, authenticated;
revoke all on function public.finish_hivra_agent_wake(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint),
  public.finish_hivra_agent_sleep(uuid, uuid, text),
  public.claim_hivra_agent_wake(uuid, uuid),
  public.finish_hivra_agent_wake(uuid, uuid, text) to service_role;
