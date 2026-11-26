-- Keep retired host identities in the inventory without including them in VM discovery.
-- Maintenance alone does not prove that a host can no longer hold a VM.
alter table public.proxmox_hosts
  add column if not exists decommissioned_at timestamptz
  constraint proxmox_hosts_decommissioned_requires_maintenance
  check (decommissioned_at is null or status = 'maintenance');

comment on column public.proxmox_hosts.decommissioned_at is
  'Set by an operator only after evacuation and permanent decommission are verified. NULL hosts can still hold VMs and must be checked before claiming absence.';
