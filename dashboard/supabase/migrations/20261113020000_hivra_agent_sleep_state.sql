-- Agent sleep and wake, Step 1: state columns and the observe-only log.
--
-- WHY
-- Idle agents hold host RAM. The sleep/wake work freezes quiet agents and wakes
-- them on demand. This step only adds the records it will need. Nothing here
-- changes how any agent runs: every default is the "awake, never sleep" value,
-- and the code that reads these columns does nothing unless HIVRA_SLEEP_MODE is
-- set. Operation kinds are NOT widened here; that comes with the step that
-- actually takes a sleep or wake lease.
--
-- 1. hivra_agents: sleep_state, sleep_tier_changed_at, sleep_generation,
--    sleep_policy, always_on, next_wake_at.
-- 2. proxmox_hosts.sleep_mode: a per-host kill switch, default off.
-- 3. hivra_agent_sleep_observations: what the policy WOULD have decided for an
--    agent at a point in time. Counts and reasons only, never content. Service
--    role only; pruned by the observe cron after 30 days.
--
-- Additive and idempotent. The CHECK constraints are added NOT VALID and then
-- validated in their own statements, so the ACCESS EXCLUSIVE lock is brief and
-- the table scan runs under a weaker lock. lock_timeout makes the migration give
-- up, rather than queue and block the table, if a long transaction holds it.

set local lock_timeout = '2s';

-- 1. hivra_agents -------------------------------------------------------------

alter table public.hivra_agents
  add column if not exists sleep_state text not null default 'awake',
  add column if not exists sleep_tier_changed_at timestamptz,
  add column if not exists sleep_generation bigint not null default 0,
  add column if not exists sleep_policy text not null default 'off',
  add column if not exists always_on boolean not null default false,
  add column if not exists next_wake_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.hivra_agents'::regclass
       and conname = 'hivra_agents_sleep_state_check'
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_sleep_state_check
      check (sleep_state in (
        'awake', 'draining', 'napping', 'sleeping',
        'hibernating', 'hibernated', 'waking', 'wake_failed'
      )) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.hivra_agents'::regclass
       and conname = 'hivra_agents_sleep_policy_check'
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_sleep_policy_check
      check (sleep_policy in ('off', 't1', 't3', 'full')) not valid;
  end if;
end
$$;

alter table public.hivra_agents validate constraint hivra_agents_sleep_state_check;
alter table public.hivra_agents validate constraint hivra_agents_sleep_policy_check;

comment on column public.hivra_agents.sleep_state is
  'Where the agent is on the sleep ladder. awake is the only value anything sets today; the rest are reserved for the sleep sweep. Independent of status.';
comment on column public.hivra_agents.sleep_tier_changed_at is
  'When sleep_state last changed. NULL until the agent has left awake at least once.';
comment on column public.hivra_agents.sleep_generation is
  'Bumped on every sleep or wake so a stale sleep request can be told apart from a current one and lose.';
comment on column public.hivra_agents.sleep_policy is
  'Per-agent kill switch for sleeping: off (never, the default), t1 (nap only), t3 (hibernate only) or full (both).';
comment on column public.hivra_agents.always_on is
  'When true the agent must never sleep, whatever its sleep_policy says.';
comment on column public.hivra_agents.next_wake_at is
  'When a sleeping agent must wake on its own (for example a scheduled job). NULL when nothing is scheduled.';

-- 2. proxmox_hosts ------------------------------------------------------------

alter table public.proxmox_hosts
  add column if not exists sleep_mode text not null default 'off';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.proxmox_hosts'::regclass
       and conname = 'proxmox_hosts_sleep_mode_check'
  ) then
    alter table public.proxmox_hosts
      add constraint proxmox_hosts_sleep_mode_check
      check (sleep_mode in ('off', 'observe', 'canary', 'on')) not valid;
  end if;
end
$$;

alter table public.proxmox_hosts validate constraint proxmox_hosts_sleep_mode_check;

comment on column public.proxmox_hosts.sleep_mode is
  'Per-host sleep switch: off (default), observe, canary or on. Acts together with the HIVRA_SLEEP_MODE environment setting; either one being off means no sleeping.';

-- 3. hivra_agent_sleep_observations ------------------------------------------

create table if not exists public.hivra_agent_sleep_observations (
  id           bigserial primary key,
  agent_id     uuid not null references public.hivra_agents(id) on delete cascade,
  observed_at  timestamptz not null default now(),
  mode         text,
  verdict      text not null check (verdict in ('awake', 'would_nap', 'would_hibernate', 'ineligible')),
  reasons      text[] not null default '{}',
  idle_seconds integer,
  agent_type   text
);

create index if not exists hivra_agent_sleep_observations_agent_idx
  on public.hivra_agent_sleep_observations using btree (agent_id, observed_at desc);

create index if not exists hivra_agent_sleep_observations_observed_at_idx
  on public.hivra_agent_sleep_observations using btree (observed_at);

alter table public.hivra_agent_sleep_observations enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_sleep_observations from anon, authenticated;
revoke all on sequence public.hivra_agent_sleep_observations_id_seq from anon, authenticated;

comment on table public.hivra_agent_sleep_observations is
  'What the sleep policy would have decided for an agent at a point in time. Written by the observe-only cron; never acted on. Counts and reasons only, no content. Rows older than 30 days are pruned.';
comment on column public.hivra_agent_sleep_observations.mode is
  'The HIVRA_SLEEP_MODE value the cron ran under when it wrote the row.';
comment on column public.hivra_agent_sleep_observations.verdict is
  'awake, would_nap, would_hibernate or ineligible.';
comment on column public.hivra_agent_sleep_observations.reasons is
  'Short machine-readable reasons behind the verdict, including every signal that was unknown.';
comment on column public.hivra_agent_sleep_observations.idle_seconds is
  'Best known idle time at the observation, in seconds. NULL when it could not be worked out.';
comment on column public.hivra_agent_sleep_observations.agent_type is
  'The agent kind at the time, copied so the row stays readable after the agent changes.';
