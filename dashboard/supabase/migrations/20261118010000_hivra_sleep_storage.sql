-- Sleep ladder, last step: a paid agent nobody has used for days
-- (HIVRA_SLEEP_STORE_AFTER_DAYS) is packed into the storage box and its disks on
-- the host are freed. The computer keeps its number, address and settings; its
-- disks are written back when its owner returns.
--
--   sleep_stored_at            when its disks were freed (null: they are on the host)
--   sleep_store_job_id         the packing job running on the host, if any
--   sleep_store_tried_at       the last time packing was started, so a refusal is not retried every minute
--   sleep_unstore_requested_at when someone asked for it back
--   sleep_unstore_job_id       the job writing its disks back, if any
--
-- The jobs themselves are rows of hivra_computer_backups (kinds store, unstore).
-- Additive and idempotent.

alter table public.hivra_agents
  add column if not exists sleep_stored_at timestamptz,
  add column if not exists sleep_store_job_id uuid,
  add column if not exists sleep_store_tried_at timestamptz,
  add column if not exists sleep_unstore_requested_at timestamptz,
  add column if not exists sleep_unstore_job_id uuid;

comment on column public.hivra_agents.sleep_stored_at is
  'When this computer''s disks were packed into the storage box and freed on the host. Null: the disks are on the host.';

create index if not exists hivra_agents_sleep_storage_idx
  on public.hivra_agents (id)
  where sleep_stored_at is not null or sleep_store_job_id is not null
     or sleep_unstore_requested_at is not null or sleep_unstore_job_id is not null;

alter table public.hivra_computer_backups
  drop constraint if exists hivra_computer_backups_kind_check;
alter table public.hivra_computer_backups
  add constraint hivra_computer_backups_kind_check
    check (kind in ('backup', 'drill', 'restore', 'purge', 'store', 'unstore'));

-- Long sleepers whose saved memory is already dropped and whose disks are still on the host.
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
     and a.always_on = false
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
