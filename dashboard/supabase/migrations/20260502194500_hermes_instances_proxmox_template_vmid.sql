-- Track the Proxmox template VMID used for each cloned Hermes instance.
-- This gives operators a safe way to audit whether an old template is still
-- needed for rollback/provenance before pruning it from the Proxmox host.

alter table public.hermes_instances
  add column if not exists proxmox_template_vmid integer;

update public.hermes_instances
set proxmox_template_vmid = nullif(config -> 'infrastructure' ->> 'templateVmid', '')::integer
where proxmox_template_vmid is null
  and config -> 'infrastructure' ->> 'provider' = 'proxmox'
  and (config -> 'infrastructure' ->> 'templateVmid') ~ '^[0-9]+$';

create index if not exists hermes_instances_proxmox_template_vmid_idx
  on public.hermes_instances(proxmox_template_vmid)
  where proxmox_template_vmid is not null;
