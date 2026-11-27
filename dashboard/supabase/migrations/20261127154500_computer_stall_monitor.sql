create table if not exists public.ops_computer_health (
  instance_id uuid primary key references public.hermes_instances(id) on delete cascade,
  lifecycle_at timestamptz,
  observed_at timestamptz not null,
  first_failed_at timestamptz
);

alter table public.ops_computer_health enable row level security;
revoke all on public.ops_computer_health from public, anon, authenticated;
grant select, insert, update on public.ops_computer_health to service_role;

create or replace function public.record_computer_health_observations(
  p_observed_at timestamptz, p_observations jsonb
) returns void
language sql
set search_path = ''
as $$
  insert into public.ops_computer_health as h (instance_id, lifecycle_at, observed_at, first_failed_at)
  select i.id, i.last_lifecycle_transition_at, p_observed_at,
    case when not o.healthy then p_observed_at end
  from jsonb_to_recordset(p_observations) as o (
    instance_id uuid, lifecycle_at timestamptz, healthy boolean
  )
  join public.hermes_instances i on i.id = o.instance_id
  where i.status = 'running'
    and i.lifecycle_state = 'active'
    and i.deleted_at is null
    and i.last_lifecycle_transition_at is not distinct from o.lifecycle_at
  order by i.id
  on conflict (instance_id) do update set
    lifecycle_at = excluded.lifecycle_at,
    observed_at = excluded.observed_at,
    first_failed_at = case
      when excluded.first_failed_at is null then null
      when h.lifecycle_at is distinct from excluded.lifecycle_at
        or excluded.observed_at - h.observed_at > interval '15 minutes' then excluded.first_failed_at
      else coalesce(h.first_failed_at, excluded.first_failed_at)
    end
  where h.observed_at < excluded.observed_at;
$$;

revoke all on function public.record_computer_health_observations(timestamptz, jsonb) from public, anon, authenticated;
grant execute on function public.record_computer_health_observations(timestamptz, jsonb) to service_role;

create or replace function public.list_computer_stalls(p_now timestamptz)
returns table (
  signal_key text, kind text, instance_id text, reason text, host text, since timestamptz, verdict text
)
language sql
stable
set search_path = ''
as $$
  with signals as (
    select 'classic'::text as kind, i.id::text as instance_id,
      coalesce(i.proxmox_node, i.host_id::text, i.hetzner_server_id::text) as host,
      i.deleted_at is null and i.lifecycle_state = 'provisioning' as provisioning,
      coalesce(i.last_lifecycle_transition_at, i.created_at) as provisioning_since,
      i.deleted_at is null and i.status = 'running' and i.lifecycle_state = 'active' as running,
      h.observed_at,
      h.first_failed_at as failing_since,
      h.lifecycle_at is not distinct from i.last_lifecycle_transition_at as same_runtime,
      h.observed_at is not null and h.first_failed_at is null as healthy
    from public.hermes_instances i
    left join public.ops_computer_health h on h.instance_id = i.id
    where i.lifecycle_state = 'provisioning' or i.status = 'running'
    union all
    select 'native', a.id::text, a.proxmox_host,
      a.status = 'provisioning', coalesce(a.operation_started_at, a.created_at),
      a.status = 'running' and a.sleep_state = 'awake',
      p.last_seen_at, case when p.archived_at is null then p.first_seen_at end,
      coalesce(p.first_seen_at >= greatest(a.provisioned_at, a.sleep_tier_changed_at, a.created_at), false),
      p.archived_at is not null
    from public.hivra_agents a
    left join lateral (
      select first_seen_at, last_seen_at, archived_at
      from public.ops_events
      where instance_id = a.id::text and source = 'box.public_probe.unreachable'
      order by greatest(last_seen_at, archived_at) desc, id desc
      limit 1
    ) p on a.status = 'running' and a.sleep_state = 'awake'
    where a.status in ('provisioning', 'running')
  )
  select s.kind || ':provisioning:' || s.instance_id,
    s.kind, s.instance_id, 'provisioning', s.host, s.provisioning_since, 'open'
    from signals s
    where s.provisioning and s.provisioning_since < p_now - interval '1 hour'
  union all
  select s.kind || ':health:' || s.instance_id,
    s.kind, s.instance_id, 'health', s.host, s.failing_since,
    case
      when s.healthy then 'cleared'
      when s.observed_at is null then 'unknown'
      when not s.same_runtime then 'cleared'
      when s.observed_at < p_now - interval '15 minutes' then 'unknown'
      when s.failing_since < p_now - interval '1 hour' then 'open'
      else 'pending'
    end
    from signals s
    where s.running
      and (
        s.failing_since < p_now - interval '1 hour'
        or exists (
          select 1 from public.ops_events e
          where e.source = 'synthetic.computer-stall.health'
            and e.instance_id = s.instance_id and e.archived_at is null
        )
      );
$$;

revoke all on function public.list_computer_stalls(timestamptz) from public, anon, authenticated;
grant execute on function public.list_computer_stalls(timestamptz) to service_role;
