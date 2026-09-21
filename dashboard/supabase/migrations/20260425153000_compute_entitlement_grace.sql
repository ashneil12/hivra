alter table public.hermes_instances
  add column if not exists entitlement_state text default 'ok',
  add column if not exists entitlement_grace_started_at timestamptz,
  add column if not exists entitlement_grace_ends_at timestamptz,
  add column if not exists entitlement_last_checked_at timestamptz,
  add column if not exists entitlement_reason text,
  add column if not exists entitlement_suspended_at timestamptz,
  add column if not exists entitlement_last_resumed_at timestamptz;

update public.hermes_instances
set entitlement_state = 'ok'
where entitlement_state is null;

alter table public.hermes_instances
  alter column entitlement_state set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'hermes_instances_entitlement_state_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_entitlement_state_check
      check (entitlement_state in ('ok', 'grace', 'suspended'));
  end if;
end $$;

create index if not exists hermes_instances_entitlement_state_idx
  on public.hermes_instances(entitlement_state);

create index if not exists hermes_instances_credit_entitlement_idx
  on public.hermes_instances(resource_tier, lifecycle_state, entitlement_state)
  where resource_tier = 'credit_base'
    and lifecycle_state <> 'deleted';
