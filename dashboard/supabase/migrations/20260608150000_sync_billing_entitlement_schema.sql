-- Keep canary and prod aligned for the active billing/entitlement schema.
--
-- This migration is intentionally additive/idempotent. It does not copy any
-- customer data between environments; it only makes the live tables accept the
-- same entitlement writes in both databases.

alter table public.hermes_subscriptions
  add column if not exists excess_resources boolean not null default false;

comment on column public.hermes_subscriptions.excess_resources is
  'True when the account is temporarily above its current plan resource limits after a billing state change.';

alter table public.hermes_instances
  add column if not exists webfree boolean not null default false;

comment on column public.hermes_instances.webfree is
  'When true, render the webui-free stack instead of the legacy webui-image stack. Separate from backend so rollout can be staged per row.';

update public.hermes_instances
set disk_size_gb = 40
where disk_size_gb is null;

alter table public.hermes_instances
  alter column disk_size_gb set default 40,
  alter column disk_size_gb set not null;

update public.hermes_instances
set disk_upgraded = false
where disk_upgraded is null;

alter table public.hermes_instances
  alter column disk_upgraded set default false,
  alter column disk_upgraded set not null;
