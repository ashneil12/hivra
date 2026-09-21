-- Disk-capacity awareness for Proxmox host placement.
--
-- Until now rankProxmoxHostsForPlacement filtered candidate hosts only
-- on free CPU and free RAM. A scheduler without disk awareness can keep
-- landing placements on a host that is structurally out of disk.
--
-- thinpool_size_gb: physical LVM-thin pool size in GB. Verify with
--   ssh root@<host> 'lvs vg0/<pool> --units g --no-headings -o lv_size'
-- NULL = unknown; the placement filter skips the disk check on hosts
-- with NULL so a missing measurement doesn't take provisioning offline.
--
-- thinpool_overcommit_ratio: allowed provisioned-disk overcommit on top
-- of thinpool_size_gb. Default 1.5 — the whole point of thin
-- provisioning is that real usage averages well below allocation
-- (~60% in our fleet), so allowing 150% provisioned is the conservative
-- baseline. An operator can dial it down per host when measured usage runs
-- closer to provisioned.
--
-- Reclaim caveat: in-guest `fstrim` does NOT shrink the host thin pool
-- on some guest/storage combinations because the qemu throttle layer may not
-- propagate DISCARD to the thin pool.
-- That means we cannot rely on reclamation; the placement-time filter
-- this column unlocks is the load-bearing safeguard against saturation.

alter table public.proxmox_hosts
  add column if not exists thinpool_size_gb integer,
  add column if not exists thinpool_overcommit_ratio numeric not null default 1.5;

comment on column public.proxmox_hosts.thinpool_size_gb is
  'Physical LVM-thin pool size in GB. NULL = unknown (placement skips '
  'the disk filter on this host). Verify with '
  '`lvs vg0/<pool> --units g --no-headings -o lv_size`.';

comment on column public.proxmox_hosts.thinpool_overcommit_ratio is
  'Allowed provisioned-disk overcommit factor over thinpool_size_gb. '
  'Default 1.5 — real usage typically runs ~60% of allocation, so '
  '150% provisioned keeps headroom while exploiting thin provisioning. '
  'Lower per-host when historical usage runs closer to provisioned.';
