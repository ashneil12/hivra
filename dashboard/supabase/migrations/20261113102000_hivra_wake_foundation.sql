-- Shared state for host ingress and channel wake. Dark until the flags are set.
--
-- WHY
-- Two features build on this. Host ingress moves an agent's public connector
-- from its computer to the host, so a request can wake a sleeping agent.
-- Channel wake generalises Telegram wake-on-message to other channels. Both
-- need somewhere to keep per-agent state, and both write sleep events with a
-- new trigger. Nothing reads or writes these tables until HIVRA_HOST_INGRESS
-- or HIVRA_CHANNEL_WAKE is set, and with no rows nothing changes.
--
-- 1. hivra_agent_ingress: one row per agent that has started the move to host
--    ingress. mode says which side serves the agent's public address; phase
--    records how far an enable or rollback got. Service role only.
-- 2. hivra_agent_channel_wake: one row per agent and channel that opted in.
--    No credential is stored here, only a short fingerprint. Service role only.
-- 3. proxmox_hosts.ingress_mode: a per-host switch, default off.
-- 4. hivra_agent_sleep_events.trigger admits 'ingress' and 'channel'. Both are
--    added here, in one statement, because each widening drops and recreates
--    the whole check: a second migration doing the same would erase the first.
--
-- Additive and idempotent. Checks are added NOT VALID and then validated in
-- their own statement, so the strong lock is brief.

set local lock_timeout = '2s';

-- 1. hivra_agent_ingress -------------------------------------------------------

create table if not exists public.hivra_agent_ingress (
  agent_id      uuid primary key references public.hivra_agents(id) on delete cascade,
  vmid          integer not null check (vmid > 0),
  host_id       text not null references public.proxmox_hosts(id) on update cascade on delete restrict,
  mode          text not null default 'guest' check (mode in ('guest', 'host')),
  phase         text not null default 'none'
                check (phase in ('none', 'forwarder', 'host_connector', 'cutover', 'rolled_back', 'failed')),
  metrics_port  integer check (metrics_port is null or metrics_port between 1024 and 65535),
  generation    bigint not null default 0 check (generation >= 0),
  last_error    text check (last_error is null or last_error ~ '^[a-z_]{1,40}$'),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index if not exists hivra_agent_ingress_host_metrics_port_idx
  on public.hivra_agent_ingress using btree (host_id, metrics_port)
  where metrics_port is not null;

create index if not exists hivra_agent_ingress_host_mode_idx
  on public.hivra_agent_ingress using btree (host_id, mode);

alter table public.hivra_agent_ingress enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_ingress from public, anon, authenticated;

comment on table public.hivra_agent_ingress is
  'Per-agent host ingress state: which side serves the public address, and how far a move got. Service role only.';
comment on column public.hivra_agent_ingress.mode is
  'guest (the computer runs its own connector, as before) or host (the host runs it and can wake the computer).';
comment on column public.hivra_agent_ingress.phase is
  'none, forwarder, host_connector, cutover, rolled_back or failed. Any failure leaves the agent reachable.';
comment on column public.hivra_agent_ingress.metrics_port is
  'The host connector''s local metrics port. Unique per host.';
comment on column public.hivra_agent_ingress.generation is
  'Changes with every enable or rollback. Keys derived from it stop working when it moves on.';

-- 2. hivra_agent_channel_wake -------------------------------------------------

create table if not exists public.hivra_agent_channel_wake (
  agent_id           uuid not null references public.hivra_agents(id) on delete cascade,
  channel            text not null check (channel ~ '^[a-z][a-z0-9_]{0,31}$'),
  enabled            boolean not null default false,
  cred_fp            text check (cred_fp is null or cred_fp ~ '^[0-9a-f]{16}$'),
  state              text not null default 'idle'
                     check (state in ('idle', 'pending_arm', 'arming', 'armed', 'disarm_failed')),
  arm_id             uuid,
  arm_data           jsonb not null default '{}'::jsonb check (jsonb_typeof(arm_data) = 'object'),
  pending_since      timestamptz,
  next_attempt_at    timestamptz,
  arm_failures       integer not null default 0 check (arm_failures >= 0),
  blocked_until      timestamptz,
  deferred_wake_at   timestamptz,
  wake_count_window  jsonb not null default '[]'::jsonb check (jsonb_typeof(wake_count_window) = 'array'),
  last_error         text check (last_error is null or last_error ~ '^[a-z_]{1,40}$'),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  primary key (agent_id, channel)
);

create index if not exists hivra_agent_channel_wake_state_idx
  on public.hivra_agent_channel_wake using btree (state, pending_since)
  where state <> 'idle';

create index if not exists hivra_agent_channel_wake_deferred_idx
  on public.hivra_agent_channel_wake using btree (deferred_wake_at)
  where deferred_wake_at is not null;

alter table public.hivra_agent_channel_wake enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_channel_wake from public, anon, authenticated;

comment on table public.hivra_agent_channel_wake is
  'Per-agent, per-channel wake-on-message state. Holds no credential, only a fingerprint. Service role only.';
comment on column public.hivra_agent_channel_wake.cred_fp is
  'First 16 hex characters of the sha256 of the channel credential. Not reversible; compared with the idle probe.';
comment on column public.hivra_agent_channel_wake.arm_id is
  'Changes with every arm. Per-arm secrets are derived from it, so an earlier arm''s secret stops working.';
comment on column public.hivra_agent_channel_wake.arm_data is
  'What the adapter needs to tell a new message from an old one (for example a mailbox baseline). Never secrets or content.';
comment on column public.hivra_agent_channel_wake.deferred_wake_at is
  'A wake over the hourly cap is deferred to this time, never dropped.';
comment on column public.hivra_agent_channel_wake.wake_count_window is
  'Recent wake times for the hourly cap.';

-- 3. proxmox_hosts.ingress_mode -----------------------------------------------

alter table public.proxmox_hosts
  add column if not exists ingress_mode text not null default 'off';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.proxmox_hosts'::regclass
       and conname = 'proxmox_hosts_ingress_mode_check'
  ) then
    alter table public.proxmox_hosts
      add constraint proxmox_hosts_ingress_mode_check
      check (ingress_mode in ('off', 'canary', 'on')) not valid;
  end if;
end
$$;

alter table public.proxmox_hosts validate constraint proxmox_hosts_ingress_mode_check;

comment on column public.proxmox_hosts.ingress_mode is
  'Per-host ingress switch: off (default), canary or on. Acts together with the HIVRA_HOST_INGRESS environment setting; either one being off means no ingress code runs on this host.';

-- 4. Sleep event trigger ------------------------------------------------------

alter table public.hivra_agent_sleep_events drop constraint if exists hivra_agent_sleep_events_trigger_check;
alter table public.hivra_agent_sleep_events add constraint hivra_agent_sleep_events_trigger_check
  check (trigger in ('sweep', 'manual', 'open', 'action', 'schedule', 'reconcile', 'telegram', 'ingress', 'channel')) not valid;
alter table public.hivra_agent_sleep_events validate constraint hivra_agent_sleep_events_trigger_check;

comment on column public.hivra_agent_sleep_events.trigger is
  'What started it: sweep, manual, open (the owner opened the agent), action, schedule, reconcile, telegram (a message to its bot), ingress (a request to its public address) or channel (a message on another channel).';

grant select, insert, update, delete on public.hivra_agent_ingress to service_role;
grant select, insert, update, delete on public.hivra_agent_channel_wake to service_role;
