alter table public.hermes_instances
  add column if not exists last_usage_billed_at timestamptz;

create index if not exists hermes_instances_credit_billing_cursor_idx
  on public.hermes_instances(resource_tier, lifecycle_state, last_usage_billed_at)
  where resource_tier = 'credit_base'
    and lifecycle_state = 'active';
