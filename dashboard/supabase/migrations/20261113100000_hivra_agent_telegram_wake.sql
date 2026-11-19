-- Wake a sleeping agent when its Telegram bot gets a message.
--
-- WHY
-- A Hermes agent that reads Telegram by long polling cannot hear anything while
-- its computer is paused or saved to disk. With the owner's opt-in, the sleep
-- sweep points the bot's webhook at Hivra once the agent is asleep. The first
-- message makes Telegram call Hivra, which deletes the webhook again (so the
-- message stays queued for Hermes) and wakes the agent. Everything here is dark
-- until HIVRA_TELEGRAM_WAKE is set; with no rows nothing changes.
--
-- 1. hivra_agent_telegram_wake: one row per agent that opted in. The bot token
--    is kept encrypted by the server (never readable by any client), with a
--    short fingerprint so the idle probe can say whether the agent still uses
--    the same bot. Service role only.
-- 2. hivra_agent_sleep_events.trigger admits 'telegram'.
-- 3. claim_hivra_agent_tg_arm and finish_hivra_agent_tg_arm: the sweep's lease
--    for setting a webhook. The claim takes the agent row lock and only goes
--    ahead while the agent is asleep with no operation in flight, so a wake
--    that has claimed the agent always wins. The finish only applies while the
--    same arm still holds the row; when it does not, the caller undoes its
--    webhook. Service role only.
--
-- Additive and idempotent. The widened trigger check is added NOT VALID and
-- then validated in its own statement, so the strong lock is brief.

set local lock_timeout = '2s';

-- 1. hivra_agent_telegram_wake ------------------------------------------------

create table if not exists public.hivra_agent_telegram_wake (
  agent_id         uuid primary key references public.hivra_agents(id) on delete cascade,
  user_id          text not null,
  enabled          boolean not null default false,
  token_enc        text,
  token_fp         text check (token_fp is null or token_fp ~ '^[0-9a-f]{16}$'),
  bot_id           bigint,
  state            text not null default 'idle'
                   check (state in ('idle', 'pending_arm', 'arming', 'armed', 'disarm_failed')),
  arm_id           uuid,
  arm_started_at   timestamptz,
  armed_at         timestamptz,
  pending_since    timestamptz,
  next_attempt_at  timestamptz,
  arm_failures     integer not null default 0 check (arm_failures >= 0),
  blocked_until    timestamptz,
  last_error       text check (last_error is null or last_error ~ '^[a-z_]{1,40}$'),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists hivra_agent_telegram_wake_state_idx
  on public.hivra_agent_telegram_wake using btree (state, pending_since)
  where state <> 'idle';

alter table public.hivra_agent_telegram_wake enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_telegram_wake from public, anon, authenticated;

comment on table public.hivra_agent_telegram_wake is
  'Per-agent Telegram wake-on-message state. The bot token is server-encrypted; never readable by clients.';
comment on column public.hivra_agent_telegram_wake.token_enc is
  'The bot token, encrypted by the server with its own key. Never logged.';
comment on column public.hivra_agent_telegram_wake.token_fp is
  'First 16 hex characters of the sha256 of the token. Not reversible; compared with the idle probe.';
comment on column public.hivra_agent_telegram_wake.state is
  'idle (no webhook), pending_arm (asleep, waiting for the sweep), arming, armed, or disarm_failed (the sweep retries).';
comment on column public.hivra_agent_telegram_wake.arm_id is
  'Changes with every arm. The webhook secret is derived from it, so an old webhook secret stops working.';

-- 2. Sleep event trigger ------------------------------------------------------

alter table public.hivra_agent_sleep_events drop constraint if exists hivra_agent_sleep_events_trigger_check;
alter table public.hivra_agent_sleep_events add constraint hivra_agent_sleep_events_trigger_check
  check (trigger in ('sweep', 'manual', 'open', 'action', 'schedule', 'reconcile', 'telegram')) not valid;
alter table public.hivra_agent_sleep_events validate constraint hivra_agent_sleep_events_trigger_check;

comment on column public.hivra_agent_sleep_events.trigger is
  'What started it: sweep, manual, open (the owner opened the agent), action, schedule, reconcile or telegram (a message to its bot).';

-- 3. Arm lease ----------------------------------------------------------------

-- Take a row for arming. Returns the row's failure count so far, or null when
-- refused: the row is not waiting to be armed (or an arm older than two
-- minutes is not being replaced), it is not enabled, it is blocked or backing
-- off, its nap is younger than p_min_pending_s, or the agent is not plainly
-- asleep with no operation in flight.
create or replace function public.claim_hivra_agent_tg_arm(
  p_agent_id uuid, p_arm_id uuid, p_min_pending_s integer)
returns integer language plpgsql security definer set search_path = public as $$
declare a public.hivra_agents%rowtype; t public.hivra_agent_telegram_wake%rowtype;
begin
  if p_agent_id is null or p_arm_id is null or p_min_pending_s is null or p_min_pending_s < 0 then return null; end if;
  -- The agent row first, the same order every wake takes, so a wake claim and this never cross.
  select * into a from public.hivra_agents where id = p_agent_id for update;
  if not found then return null; end if;
  select * into t from public.hivra_agent_telegram_wake where agent_id = p_agent_id for update;
  if not found then return null; end if;
  if t.enabled is distinct from true or t.token_enc is null then return null; end if;
  if not (t.state = 'pending_arm'
    or (t.state = 'arming' and t.arm_started_at < clock_timestamp() - interval '2 minutes')) then return null; end if;
  if t.pending_since is null or t.pending_since > clock_timestamp() - make_interval(secs => p_min_pending_s) then return null; end if;
  if t.next_attempt_at is not null and t.next_attempt_at > clock_timestamp() then return null; end if;
  if t.blocked_until is not null and t.blocked_until > clock_timestamp() then return null; end if;
  if a.status is distinct from 'running' or a.desired_state is distinct from 'running'
    or a.operation_id is not null or a.sleep_state not in ('napping', 'hibernated') then return null; end if;
  update public.hivra_agent_telegram_wake set
    state = 'arming', arm_id = p_arm_id, arm_started_at = clock_timestamp(), updated_at = clock_timestamp()
  where agent_id = p_agent_id;
  return t.arm_failures;
end;
$$;

-- Release an arm lease. p_result is armed, pending_arm (try again from
-- p_retry_at; p_failed counts it as a failure) or blocked (no webhook until
-- p_retry_at). Changes nothing, and returns false, when this arm no longer
-- holds the row: a wake took it over, and the caller must undo its webhook.
create or replace function public.finish_hivra_agent_tg_arm(
  p_agent_id uuid, p_arm_id uuid, p_result text, p_failed boolean, p_retry_at timestamptz, p_error text)
returns boolean language plpgsql security definer set search_path = public as $$
declare t public.hivra_agent_telegram_wake%rowtype;
begin
  if p_agent_id is null or p_arm_id is null or p_result is null
    or p_result not in ('armed', 'pending_arm', 'blocked') then return false; end if;
  if p_error is not null and p_error !~ '^[a-z_]{1,40}$' then p_error := 'unknown'; end if;
  select * into t from public.hivra_agent_telegram_wake
    where agent_id = p_agent_id and arm_id = p_arm_id and state = 'arming' for update;
  if not found then return false; end if;
  if p_result = 'armed' then
    update public.hivra_agent_telegram_wake set state = 'armed', armed_at = clock_timestamp(),
      arm_failures = 0, next_attempt_at = null, last_error = null, updated_at = clock_timestamp()
    where agent_id = p_agent_id;
  elsif p_result = 'pending_arm' then
    update public.hivra_agent_telegram_wake set state = 'pending_arm',
      arm_failures = t.arm_failures + (case when p_failed then 1 else 0 end),
      next_attempt_at = p_retry_at, last_error = p_error, updated_at = clock_timestamp()
    where agent_id = p_agent_id;
  else
    update public.hivra_agent_telegram_wake set state = 'idle', blocked_until = p_retry_at,
      arm_failures = 0, next_attempt_at = null, pending_since = null, last_error = p_error,
      updated_at = clock_timestamp()
    where agent_id = p_agent_id;
  end if;
  return true;
end;
$$;

revoke all on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.finish_hivra_agent_tg_arm(uuid, uuid, text, boolean, timestamptz, text) from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_tg_arm(uuid, uuid, integer),
  public.finish_hivra_agent_tg_arm(uuid, uuid, text, boolean, timestamptz, text) to service_role;
grant select, insert, update, delete on public.hivra_agent_telegram_wake to service_role;
