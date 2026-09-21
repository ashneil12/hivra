-- Keep the v2 lifecycle mirror aligned for active rows that were updated by
-- older route handlers which only wrote the legacy `status` column.
update public.hermes_instances
set lifecycle_state = case status
    when 'provisioning' then 'provisioning'
    when 'redeploying' then 'provisioning'
    when 'running' then 'active'
    when 'stopped' then 'paused'
    when 'error' then 'failed'
    when 'failed' then 'failed'
  end,
  last_lifecycle_transition_at = coalesce(last_lifecycle_transition_at, updated_at, now()),
  updated_at = now()
where status in ('provisioning', 'redeploying', 'running', 'stopped', 'error', 'failed')
  and lifecycle_state is distinct from case status
    when 'provisioning' then 'provisioning'
    when 'redeploying' then 'provisioning'
    when 'running' then 'active'
    when 'stopped' then 'paused'
    when 'error' then 'failed'
    when 'failed' then 'failed'
  end;
