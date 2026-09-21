-- Prevent two live Hivra agent rows from claiming the same VMID on one
-- Proxmox host. VMIDs are host-local, so the host is part of the key; deleted
-- rows are excluded so their historical metadata does not block reuse.

create unique index if not exists hivra_agents_active_proxmox_host_vmid_idx
  on public.hivra_agents (
    (coalesce(nullif(proxmox_host, ''), '__legacy__')),
    vmid
  )
  where vmid is not null
    and status <> 'deleted';
