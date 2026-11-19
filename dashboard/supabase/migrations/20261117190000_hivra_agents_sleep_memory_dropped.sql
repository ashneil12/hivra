-- Long sleepers: when the sleep sweep drops the saved memory of an agent that
-- has been in deep sleep for days (HIVRA_SLEEP_DROP_MEMORY_AFTER_DAYS), it
-- records the time here. The agent keeps its disk and boots from it on the next
-- wake. A value older than sleep_tier_changed_at belongs to an earlier sleep.
--
-- Additive and idempotent.

alter table public.hivra_agents
  add column if not exists sleep_memory_dropped_at timestamptz;

comment on column public.hivra_agents.sleep_memory_dropped_at is
  'When the saved memory of this deep sleep was dropped (disk kept). Older than sleep_tier_changed_at: from an earlier sleep.';

-- Agents in deep sleep since before the cutoff whose saved memory is still there.
create or replace function public.hivra_sleep_memory_drop_candidates(p_cutoff timestamptz, p_limit integer)
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
     and a.sleep_tier_changed_at <= p_cutoff
     and (a.sleep_memory_dropped_at is null or a.sleep_memory_dropped_at < a.sleep_tier_changed_at)
     -- A job due soon would boot it from disk straight away.
     and (a.next_wake_at is null or a.next_wake_at > now() + interval '1 day')
   order by a.sleep_tier_changed_at asc
   limit greatest(1, least(coalesce(p_limit, 10), 100));
$$;

revoke all on function public.hivra_sleep_memory_drop_candidates(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.hivra_sleep_memory_drop_candidates(timestamptz, integer) to service_role;
