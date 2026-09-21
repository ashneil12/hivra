alter table public.hermes_instances
  add column if not exists lifecycle_state text,
  add column if not exists infrastructure_provider text,
  add column if not exists resource_tier text,
  add column if not exists proxmox_node text,
  add column if not exists proxmox_vmid integer,
  add column if not exists deleted_at timestamptz,
  add column if not exists last_lifecycle_transition_at timestamptz;

update public.hermes_instances
set lifecycle_state = case status
  when 'running' then 'active'
  when 'stopped' then 'paused'
  when 'deleted' then 'deleted'
  when 'error' then 'failed'
  when 'failed' then 'failed'
  else 'provisioning'
end
where lifecycle_state is null;

update public.hermes_instances
set infrastructure_provider = case
  when config -> 'infrastructure' ->> 'provider' = 'proxmox' then 'proxmox'
  when hetzner_server_id is not null then 'hetzner'
  else infrastructure_provider
end
where infrastructure_provider is null;

update public.hermes_instances
set proxmox_vmid = nullif(config -> 'infrastructure' ->> 'vmid', '')::integer
where proxmox_vmid is null
  and config -> 'infrastructure' ->> 'provider' = 'proxmox'
  and (config -> 'infrastructure' ->> 'vmid') ~ '^[0-9]+$';

update public.hermes_instances
set deleted_at = updated_at
where deleted_at is null
  and lifecycle_state = 'deleted';

update public.hermes_instances
set last_lifecycle_transition_at = updated_at
where last_lifecycle_transition_at is null;

alter table public.hermes_instances
  alter column lifecycle_state set default 'provisioning',
  alter column lifecycle_state set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hermes_instances_lifecycle_state_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_lifecycle_state_check
      check (lifecycle_state in (
        'pending',
        'provisioning',
        'active',
        'paused',
        'suspended',
        'deleting',
        'deleted',
        'failed'
      ));
  end if;
end $$;

create index if not exists hermes_instances_lifecycle_state_idx
  on public.hermes_instances(lifecycle_state);

create index if not exists hermes_instances_user_lifecycle_idx
  on public.hermes_instances(user_id, lifecycle_state);

create unique index if not exists hermes_instances_active_proxmox_vmid_idx
  on public.hermes_instances(proxmox_vmid)
  where proxmox_vmid is not null
    and lifecycle_state <> 'deleted';
