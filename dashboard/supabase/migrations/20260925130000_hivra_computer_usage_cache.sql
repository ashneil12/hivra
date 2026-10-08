-- Live usage cache for Manage (GET /api/hivra/agents/[id]/usage).
--
-- A computer's usage is read from its host by a read-only script. This table
-- keeps the last observation per computer so that, across every server
-- instance, the host is read at most once per freshness window, and so the
-- last known values can still be shown when the host can't be reached.
--
-- 1. hivra_computer_usage: one row per computer. `sample` is the whitelisted
--    observation the route stored (numbers and a filesystem type only; never a
--    host name, address or another computer's data). `refresh_claimed_until`
--    is the single-flight claim, held by a reader while it reads the host.
--    `refresh_retry_after` holds off the next read after a failed one. Service
--    role only: RLS on, no policies.
--
-- 2. claim_hivra_computer_usage_refresh: claims the next host read on the
--    database clock. It succeeds only when no claim is live, no failed read is
--    being backed off, and the stored observation is older than p_fresh_seconds
--    (0 skips that check, for an observation made before the computer's last
--    state change). The row is created on first use, for the computer's owner
--    only. A caller that doesn't get the claim is told whether a reader is
--    reading right now (`refreshing`), so a backed-off failure is never shown
--    as a read in progress.
--
-- 3. record_hivra_computer_usage: stores a read. A sample replaces the
--    observation and releases the claim; an error releases the claim and backs
--    off until the claim would have expired, so a failing host is not read
--    again by every request.
--
-- 4. The row is deleted when its computer is deleted (status 'deleted', a soft
--    delete, so the foreign key's cascade never fires on its own), like the
--    computer's activity records. Account deletion removes the rest by user_id
--    (ACCOUNT_DELETION_TABLES).
--
-- Additive and idempotent: every statement can be re-run.

create table if not exists public.hivra_computer_usage (
  agent_id              uuid        primary key references public.hivra_agents (id) on delete cascade,
  user_id               text        not null check (btrim(user_id) <> ''),
  source                text        not null check (source in ('proxmox', 'hetzner', 'gvisor', 'digitalocean')),
  sample                jsonb       check (sample is null or (jsonb_typeof(sample) = 'object' and pg_column_size(sample) < 8192)),
  observed_at           timestamptz,
  refresh_claimed_until timestamptz,
  refresh_retry_after   timestamptz,
  last_error_code       text        check (last_error_code is null or last_error_code ~ '^[a-z_]{1,40}$'),
  updated_at            timestamptz not null default now(),
  constraint hivra_computer_usage_observation_check check ((sample is null) = (observed_at is null))
);

alter table public.hivra_computer_usage enable row level security;
revoke all on public.hivra_computer_usage from public, anon, authenticated;
grant all on public.hivra_computer_usage to service_role;

create or replace function public.claim_hivra_computer_usage_refresh(
  p_agent_id uuid,
  p_user_id text,
  p_source text,
  p_fresh_seconds integer,
  p_claim_seconds integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.hivra_computer_usage%rowtype;
  v_claimed boolean := false;
  v_now timestamptz := pg_catalog.now();
begin
  if p_agent_id is null or p_user_id is null
    or p_fresh_seconds is null or p_fresh_seconds < 0 or p_fresh_seconds > 3600
    or p_claim_seconds is null or p_claim_seconds < 1 or p_claim_seconds > 300 then
    raise exception 'invalid computer usage claim' using errcode = '22023';
  end if;

  -- Only the computer's owner gets a row, and never for a deleted computer.
  insert into public.hivra_computer_usage (agent_id, user_id, source)
  select a.id, a.user_id, p_source
    from public.hivra_agents a
   where a.id = p_agent_id and a.user_id = p_user_id and a.status <> 'deleted'
  on conflict (agent_id) do nothing;

  update public.hivra_computer_usage u
     set refresh_claimed_until = v_now + pg_catalog.make_interval(secs => p_claim_seconds),
         updated_at = v_now
   where u.agent_id = p_agent_id
     and u.user_id = p_user_id
     and (u.refresh_claimed_until is null or u.refresh_claimed_until <= v_now)
     and (u.refresh_retry_after is null or u.refresh_retry_after <= v_now)
     and (p_fresh_seconds = 0 or u.observed_at is null
          or u.observed_at <= v_now - pg_catalog.make_interval(secs => p_fresh_seconds))
  returning u.* into v_row;
  v_claimed := found;

  if not v_claimed then
    select u.* into v_row
      from public.hivra_computer_usage u
     where u.agent_id = p_agent_id and u.user_id = p_user_id;
  end if;

  return pg_catalog.jsonb_build_object(
    'claimed', v_claimed,
    -- Another reader holds the claim right now (not a backed-off failure).
    'refreshing', not v_claimed and v_row.refresh_claimed_until is not null and v_row.refresh_claimed_until > v_now,
    'sample', v_row.sample,
    'observedAt', v_row.observed_at,
    'lastErrorCode', v_row.last_error_code
  );
end;
$$;

create or replace function public.record_hivra_computer_usage(
  p_agent_id uuid,
  p_user_id text,
  p_sample jsonb,
  p_error_code text,
  p_clear_sample boolean default false
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.hivra_computer_usage%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if p_agent_id is null or p_user_id is null
    or (p_sample is not null and coalesce(p_clear_sample, false)) then
    raise exception 'invalid computer usage record' using errcode = '22023';
  end if;

  if p_sample is not null then
    update public.hivra_computer_usage u
       set sample = p_sample,
           observed_at = v_now,
           last_error_code = p_error_code,
           refresh_claimed_until = null,
           refresh_retry_after = null,
           updated_at = v_now
     where u.agent_id = p_agent_id and u.user_id = p_user_id
    returning u.* into v_row;
  elsif coalesce(p_clear_sample, false) then
    update public.hivra_computer_usage u
       set sample = null,
           observed_at = null,
           last_error_code = p_error_code,
           refresh_retry_after = u.refresh_claimed_until,
           refresh_claimed_until = null,
           updated_at = v_now
     where u.agent_id = p_agent_id and u.user_id = p_user_id
    returning u.* into v_row;
  else
    update public.hivra_computer_usage u
       set last_error_code = p_error_code,
           refresh_retry_after = u.refresh_claimed_until,
           refresh_claimed_until = null,
           updated_at = v_now
     where u.agent_id = p_agent_id and u.user_id = p_user_id
    returning u.* into v_row;
  end if;

  if not found then
    return null;
  end if;
  return pg_catalog.jsonb_build_object(
    'sample', v_row.sample,
    'observedAt', v_row.observed_at,
    'lastErrorCode', v_row.last_error_code
  );
end;
$$;

revoke all on function public.claim_hivra_computer_usage_refresh(uuid, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.record_hivra_computer_usage(uuid, text, jsonb, text, boolean) from public, anon, authenticated;
grant execute on function public.claim_hivra_computer_usage_refresh(uuid, text, text, integer, integer) to service_role;
grant execute on function public.record_hivra_computer_usage(uuid, text, jsonb, text, boolean) to service_role;

-- A deleted computer's usage goes with it. Computers are soft-deleted (status
-- 'deleted', only after verified teardown, on every delete path), so the
-- foreign key's cascade alone would keep the row for good.
create or replace function public.delete_hivra_computer_usage_after_agent_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status is distinct from 'deleted' and new.status = 'deleted' then
    delete from public.hivra_computer_usage u where u.agent_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists delete_hivra_computer_usage_after_agent_delete on public.hivra_agents;
create trigger delete_hivra_computer_usage_after_agent_delete
after update of status on public.hivra_agents
for each row execute function public.delete_hivra_computer_usage_after_agent_delete();

revoke all on function public.delete_hivra_computer_usage_after_agent_delete() from public, anon, authenticated;
