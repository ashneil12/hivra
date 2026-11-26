-- Per-computer authoritative seat funding for holder seats.
--
-- `seat_funding` is written only by server-side admission/provisioning after
-- the entitlement that funds that one computer has been decided. Null rows are
-- pre-feature or unknown and keep their existing behavior. The sleep lease
-- contract mirrors the runtime rule: a holder-funded computer's stale
-- always_on value is not an owner override, while every paid or unknown seat
-- keeps the existing always-on protection.

set local lock_timeout = '2s';

alter table public.hivra_agents
  add column if not exists seat_funding text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.hivra_agents'::regclass
       and conname = 'hivra_agents_seat_funding_check'
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_seat_funding_check
      check (seat_funding is null or seat_funding in ('paid', 'holder')) not valid;
  end if;
end
$$;

alter table public.hivra_agents validate constraint hivra_agents_seat_funding_check;

comment on column public.hivra_agents.seat_funding is
  'Authoritative funding cohort for this one computer: paid or holder. Null means pre-feature or unknown. Written by server admission/provisioning only; never inferred from client input or user-level token ownership.';

-- Hermes instances are part of the same hosted-compute estate. Their funding
-- cohort is fixed at provisioning time as well, so legacy holder seats do not
-- silently change terms when the account later adds, removes, or replaces a
-- subscription.
alter table public.hermes_instances
  add column if not exists seat_funding text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.hermes_instances'::regclass
       and conname = 'hermes_instances_seat_funding_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_seat_funding_check
      check (seat_funding is null or seat_funding in ('paid', 'holder')) not valid;
  end if;
end
$$;

alter table public.hermes_instances validate constraint hermes_instances_seat_funding_check;

comment on column public.hermes_instances.seat_funding is
  'Authoritative funding cohort for this hosted seat: paid or holder. Null means pre-feature or unknown. Written by server admission/provisioning only; never inferred from client input or user-level token ownership.';

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
    or (a.always_on is distinct from false and a.seat_funding is distinct from 'holder')
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

revoke all on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_sleep(uuid, uuid, text, bigint) to service_role;

-- Long-term storage is part of the same runtime sleep enforcement. A stale
-- always_on value on a holder-funded seat must not exempt it there either.
create or replace function public.hivra_sleep_store_candidates(p_cutoff timestamptz, p_limit integer)
returns table (id uuid, proxmox_host text)
language sql stable security definer set search_path = public as $$
  select a.id, a.proxmox_host
    from public.hivra_agents a
   where a.status = 'running'
     and a.desired_state = 'running'
     and a.sleep_state = 'hibernated'
     and a.operation_id is null
     and a.deployment_mode = 'hivra-managed'
     and a.computer_substrate = 'proxmox-kvm'
     and a.deployment_target_id is null
     and (a.always_on = false or a.seat_funding = 'holder')
     and a.sleep_tier_changed_at <= p_cutoff
     and a.sleep_memory_dropped_at is not null
     and a.sleep_memory_dropped_at >= a.sleep_tier_changed_at
     and a.sleep_stored_at is null
     and a.sleep_store_job_id is null
     and a.sleep_unstore_requested_at is null
     and a.sleep_unstore_job_id is null
     and (a.sleep_store_tried_at is null or a.sleep_store_tried_at < now() - interval '1 day')
     and (a.next_wake_at is null or a.next_wake_at > now() + interval '1 day')
   order by a.sleep_tier_changed_at asc
   limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

revoke all on function public.hivra_sleep_store_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.hivra_sleep_store_candidates(timestamptz, integer) to service_role;
