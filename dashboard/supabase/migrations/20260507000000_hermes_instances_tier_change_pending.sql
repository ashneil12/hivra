-- Hetzner-backed instances cannot be live-resized like Proxmox VMs. When
-- the user upgrades to a paid tier, applyTierChange writes the new
-- cpu_limit/ram_limit/resource_tier to hermes_instances, but the running
-- docker container keeps the old cgroup values until the next redeploy.
--
-- Track that the row's resource_tier is ahead of what the running
-- container was provisioned with, so the dashboard can surface a
-- "Apply your new tier" banner. Set true by tier-change-service for
-- Hetzner rows; cleared by /api/instances/[id] redeploy on success.

alter table public.hermes_instances
  add column if not exists tier_change_pending boolean not null default false;

comment on column public.hermes_instances.tier_change_pending is
  'True when the row''s resource_tier (and cpu_limit/ram_limit) is ahead of '
  'the running Hetzner container''s provisioned spec. Cleared by a '
  'successful redeploy. Always false for Proxmox-backed rows because '
  'their tier change is applied live via qm set --cpulimit/--memory.';
