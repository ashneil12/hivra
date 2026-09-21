-- Free agents use a strict 0.5 vCPU cap. The original host-limit migration
-- created hermes_instances.cpu_limit as integer, so the first Free deploy
-- tried to insert 0.5 and Postgres rejected the instance row before
-- provisioning could start.
--
-- Keep RAM as integer MB, but allow fractional vCPU values for Proxmox
-- cpulimit and any future half-core tiers.

alter table public.hermes_instances
  alter column cpu_limit type numeric(6, 2)
  using cpu_limit::numeric(6, 2);

alter table public.hermes_instances
  alter column cpu_limit set default 1;

comment on column public.hermes_instances.cpu_limit is
  'Per-instance vCPU cap. Fractional values are allowed; Free uses 0.5 vCPU.';
