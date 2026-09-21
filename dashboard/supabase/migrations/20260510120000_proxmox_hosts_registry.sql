-- Proxmox host registry for resource-aware placement.
--
-- Until now, the set of available Proxmox nodes was driven entirely by
-- HERMES_PROXMOX_TARGETS (a comma list) and per-host env vars. Placement
-- iterated that list in env order and picked the first host that wasn't
-- full. That does not account for heterogeneous host capacity or plan tiers.
--
-- This table is the new source of truth for "what Proxmox hosts exist
-- and how big are they." The placement selector reads it, computes
-- per-host headroom from sum(cpu_limit, ram_limit) of running
-- hermes_instances, and picks the host with the most free RAM that can
-- still fit the requested plan (worst-fit on the bottleneck resource).
--
-- env_prefix is nullable: when null, the existing
-- resolveProxmoxTargetConfiguration() helper derives it from the id
-- (PROXMOX_HOST_<UPPER>_* / PROXMOX_<UPPER>_* / <UPPER>_PROXMOX_*).
-- Override only when a host needs a non-default prefix.
--
-- max_tenant_instances is nullable: when null, falls back to the global
-- HERMES_PROXMOX_MAX_TENANT_INSTANCES env var. Set per-host to give a
-- specific node more (or less) headroom than the global default.
--
-- Fresh self-host installs deliberately start with an empty registry. Host
-- enrollment writes operator-owned capacity after capability detection; a
-- source migration must never seed Hivra's managed fleet inventory.

create table if not exists public.proxmox_hosts (
  id text primary key,
  env_prefix text,
  total_cpu integer not null,
  total_ram_mb integer not null,
  reserved_cpu integer not null default 2,
  reserved_ram_mb integer not null default 4096,
  wake_headroom_ram_mb integer not null default 8192,
  status text not null default 'active'
    check (status in ('active', 'draining', 'maintenance')),
  max_tenant_instances integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger proxmox_hosts_updated_at
  before update on public.proxmox_hosts
  for each row execute function update_updated_at();

alter table public.proxmox_hosts enable row level security;

-- No client-side reads/writes; only supabaseAdmin (service role) touches this.
-- Service role bypasses RLS, so we just need RLS enabled with no policies.

comment on table public.proxmox_hosts is
  'Registry of Proxmox nodes available for VM placement. Driven by '
  'placement selector (selectAvailableProxmoxProvisionTarget) — replaces '
  'the legacy HERMES_PROXMOX_TARGETS env-order iteration.';

comment on column public.proxmox_hosts.id is
  'Stable host slug, lowercase (e.g. ''compute-a''). Matches PROXMOX_NODE / '
  'hermes_instances.proxmox_node values.';

comment on column public.proxmox_hosts.env_prefix is
  'Optional override for the env var prefix used to resolve per-host '
  'PROXMOX_* secrets. NULL = derive from id (PROXMOX_HOST_<UPPER>_*).';

comment on column public.proxmox_hosts.total_cpu is
  'Logical core count of the underlying host. Verify with '
  '`pvesh get /nodes/<node>/status`.';

comment on column public.proxmox_hosts.total_ram_mb is
  'Physical RAM of the underlying host, in MB.';

comment on column public.proxmox_hosts.reserved_cpu is
  'CPU held back from placement for the Proxmox host itself + headroom. '
  'Default 2.';

comment on column public.proxmox_hosts.reserved_ram_mb is
  'RAM (MB) held back for Proxmox itself + headroom. Default 4096.';

comment on column public.proxmox_hosts.wake_headroom_ram_mb is
  'Additional RAM (MB) reserved on top of reserved_ram_mb to absorb '
  'wake bursts when paused/idle VMs come back online. Default 8192. '
  'When the inactivity-shutdown cron lands and aggressive RAM packing '
  'kicks in (stopped VMs contribute 0 RAM), this is the safety rail.';

comment on column public.proxmox_hosts.status is
  '''active'' = eligible for new placements. ''draining'' = no new '
  'placements but existing VMs keep running. ''maintenance'' = '
  'effectively offline (placement skips it).';

comment on column public.proxmox_hosts.max_tenant_instances is
  'Per-host override of HERMES_PROXMOX_MAX_TENANT_INSTANCES. NULL = '
  'use the global env default.';
