-- Atomic per-agent daily spend limit for managed-Venice holds.
--
-- The application checks an agent key's daily limit before it places a hold
-- (src/lib/billing/managed-venice-agent-spend-caps.ts). On its own that is a
-- check-then-act: many requests sent at once could all read the same "spent
-- so far" and all pass, so an agent could spend far past its limit. This
-- BEFORE INSERT trigger repeats the check inside the insert's transaction,
-- under the same per-user advisory lock the wallet balance guard takes, so
-- holds for one user are placed one at a time and each sees the ones before.
--
-- The limit travels on the hold (metadata.agentDailyCapMicroUsd), set by the
-- application only when the per-agent limit is switched on and applies to the
-- key. A hold without it is not checked here.
--
-- Counted for the key, for the current UTC day:
--   * charged spend already recorded (managed_venice_usage_events);
--   * every hold still open, whatever day it started (requests running now);
--   * holds captured today whose usage row is not written yet.
-- A new hold is refused when that plus the new hold passes the limit.
--
-- Idempotency: a reference_id already present is a retry, not a new hold.
-- Rerun-safe: create-or-replace plus drop/recreate trigger.

create or replace function public.enforce_managed_venice_agent_daily_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text;
  v_cap bigint;
  v_day timestamptz;
  v_committed bigint;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;
  if coalesce(jsonb_typeof(new.metadata -> 'agentDailyCapMicroUsd'), '') <> 'number' then
    return new;
  end if;
  v_key := coalesce(new.proxy_key_id::text, new.metadata ->> 'proxyKeyId');
  if v_key is null then
    return new;
  end if;
  if exists (
    select 1 from public.managed_venice_reservations where reference_id = new.reference_id
  ) then
    return new;
  end if;

  v_cap := floor((new.metadata ->> 'agentDailyCapMicroUsd')::numeric)::bigint;
  v_day := date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  -- Same lock as the wallet balance guard: one hold per user at a time.
  perform pg_advisory_xact_lock(hashtext('managed_venice_wallet:' || new.user_id));

  v_committed :=
    coalesce((
      select sum(charged_micro_usd) from public.managed_venice_usage_events
       where user_id = new.user_id
         and proxy_key_id::text = v_key
         and created_at >= v_day
    ), 0)
    + coalesce((
      select sum(reserved_micro_usd) from public.managed_venice_reservations
       where user_id = new.user_id
         and status = 'active'
         and coalesce(proxy_key_id::text, metadata ->> 'proxyKeyId') = v_key
    ), 0)
    + coalesce((
      select sum(r.captured_micro_usd) from public.managed_venice_reservations r
       where r.user_id = new.user_id
         and r.status = 'captured'
         and r.captured_at >= v_day
         and coalesce(r.proxy_key_id::text, r.metadata ->> 'proxyKeyId') = v_key
         and not exists (
           select 1 from public.managed_venice_usage_events u
            where u.reference_id = r.reference_id
         )
    ), 0);

  if v_committed + new.reserved_micro_usd > v_cap then
    raise exception 'managed_venice_agent_spend_cap: cap=% spent=% requested=%',
      v_cap, v_committed, new.reserved_micro_usd
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_managed_venice_agent_daily_cap() from public, anon, authenticated;

drop trigger if exists trg_enforce_mv_agent_daily_cap on public.managed_venice_reservations;
create trigger trg_enforce_mv_agent_daily_cap
  before insert on public.managed_venice_reservations
  for each row
  execute function public.enforce_managed_venice_agent_daily_cap();
