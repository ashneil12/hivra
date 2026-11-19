-- Per-host placement settings measured by the one-box stress test (2026-11-18).
--   cpu_overcommit_ratio: vCPU budget multiplier for this host; NULL keeps
--     HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO (default 5).
--   placement_skip_deep_sleep: when true, deep-sleeping agents on this host
--     hold no CPU/RAM in placement (wake admission still checks real memory).
alter table public.proxmox_hosts
  add column if not exists cpu_overcommit_ratio numeric
    check (cpu_overcommit_ratio is null or (cpu_overcommit_ratio > 0 and cpu_overcommit_ratio <= 20)),
  add column if not exists placement_skip_deep_sleep boolean not null default false;

comment on column public.proxmox_hosts.cpu_overcommit_ratio is
  'Per-host vCPU overcommit for placement; NULL = HERMES_PROXMOX_CPU_OVERCOMMIT_RATIO.';
comment on column public.proxmox_hosts.placement_skip_deep_sleep is
  'When true, deep-sleeping (hibernated) agents on this host do not count CPU/RAM in placement.';
