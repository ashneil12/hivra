-- Proxmox VMIDs are only unique within a single Proxmox host. The original
-- partial index was created for a single host, so it treated the same VMID on
-- node-a and node-b as a conflict. That can leave a running VM with a row stuck
-- at provisioning/null proxmox_vmid.

drop index if exists public.hermes_instances_active_proxmox_vmid_idx;

create unique index if not exists hermes_instances_active_proxmox_node_vmid_idx
  on public.hermes_instances (
    (coalesce(nullif(proxmox_node, ''), '__legacy__')),
    proxmox_vmid
  )
  where proxmox_vmid is not null
    and lifecycle_state <> 'deleted';
