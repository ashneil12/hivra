create table if not exists public.hivra_canary_memory_overcommit (
  singleton boolean primary key default true check (singleton),
  host_id text not null check (host_id ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  owner_id text not null check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  enabled boolean not null default false,
  ratio_milli integer not null check (ratio_milli between 1001 and 2000),
  expires_at timestamptz not null check (isfinite(expires_at)),
  customer_health_ok boolean not null default false,
  customer_health_checked_at timestamptz check (isfinite(customer_health_checked_at)),
  pressure_boot_id uuid,
  pressure_pswpin bigint check (pressure_pswpin between 0 and 9007199254740991),
  pressure_pswpout bigint check (pressure_pswpout between 0 and 9007199254740991),
  pressure_oom_kill bigint check (pressure_oom_kill between 0 and 9007199254740991),
  pressure_swap_used_kib bigint check (pressure_swap_used_kib between 0 and 64),
  qa_template_vmid integer check (qa_template_vmid between 100 and 999999999 and qa_template_vmid not between 9300 and 9399),
  measured_guest_generations jsonb not null default '{}' check (jsonb_typeof(measured_guest_generations) = 'object'),
  measured_qa_clones text[] not null default '{}'
);

comment on column public.hivra_canary_memory_overcommit.measured_guest_generations is
  'Operator allowlist: object keyed by exact VMID:hivra-bind-<32 lowercase hex>, with each guest''s measured sleep_generation as the numeric value. Re-enrol after sleep or wake.';
comment on column public.hivra_canary_memory_overcommit.measured_qa_clones is
  'Operator allowlist of exact 93xx:hivra-qa-mem-<32 lowercase hex> identities, one per VMID, never 9302. Invalid or oversized lists give no QA clone credit.';
comment on column public.hivra_canary_memory_overcommit.pressure_boot_id is
  'Boot ID for the host pressure baseline. Collect and update all pressure_* fields together with the affirmative customer-health check.';
comment on column public.hivra_canary_memory_overcommit.qa_template_vmid is
  'The operator-selected source template for QA cloning. NULL disables QA clone grants and credit without disabling exact-host managed grants.';

alter table public.hivra_canary_memory_overcommit enable row level security;
revoke all on table public.hivra_canary_memory_overcommit from public, anon, authenticated, service_role;

create or replace function public.get_hivra_canary_memory_overcommit(p_host_id text, p_owner_id text)
returns jsonb language sql stable security definer set search_path = pg_catalog, pg_temp
as $$
  with permit as (
    select s.host_id, s.owner_id, s.ratio_milli, s.qa_template_vmid, s.measured_guest_generations, s.measured_qa_clones,
      s.pressure_boot_id::text || ':' || s.pressure_pswpin::text || ':' || s.pressure_pswpout::text
        || ':' || s.pressure_oom_kill::text || ':' || s.pressure_swap_used_kib::text as pressure_baseline,
      floor(extract(epoch from least(s.expires_at, s.customer_health_checked_at + interval '10 minutes',
        statement_timestamp() + interval '90 seconds')))::bigint as valid_until_epoch
    from public.hivra_canary_memory_overcommit s
    join public.proxmox_hosts h on h.id = s.host_id
    where s.owner_id = p_owner_id
      and (s.host_id = p_host_id or (p_host_id is null and s.qa_template_vmid is not null))
      and s.enabled and s.expires_at > statement_timestamp() and s.customer_health_ok
      and s.customer_health_checked_at between statement_timestamp() - interval '10 minutes' and statement_timestamp()
      and h.status = 'active' and h.decommissioned_at is null
  ), managed_guests as (
    select distinct guest.key
    from permit p
    join public.hivra_agents a on a.proxmox_host = p.host_id and a.user_id = p.owner_id
    cross join lateral (values (a.vmid::text || ':hivra-bind-' || left(a.infrastructure_binding_token_hash, 32))) guest(key)
    where a.deployment_mode = 'hivra-managed' and a.computer_substrate = 'proxmox-kvm'
      and a.deployment_target_id is null and a.managed_provisioner_channel = 'canary'
      and a.computer_profile is distinct from 'windows' and a.type <> 'windows'
      and a.seat_funding = 'paid' and a.canary_qa_holder_expires_at is null
      and a.status = 'running' and a.desired_state = 'running' and a.sleep_state = 'awake'
      and a.operation_id is null and a.operation_kind is null
      and a.vmid between 100 and 999999999 and a.vmid <> 9302 and a.allocation_operation_id is not null
      and a.infrastructure_binding_token_enforced and a.infrastructure_binding_token_hash ~ '^[0-9a-f]{64}$'
      and p.measured_guest_generations -> guest.key = to_jsonb(a.sleep_generation)
  ), qa_settings as (
    select public.holder_admission_normalize_host_id(p.host_id) as host_key,
      q.key, substring(q.key from '^([0-9]{4}):')::integer as vmid
    from permit p
    cross join lateral unnest(p.measured_qa_clones) q(key)
    where p.qa_template_vmid is not null and array_ndims(p.measured_qa_clones) = 1
      and cardinality(p.measured_qa_clones) + (select count(*) from managed_guests) <= 64
  ), qa_clones as (
    select q.key
    from qa_settings q
    where not exists (
      select 1 from qa_settings invalid
      where (invalid.key ~ '^93[0-9]{2}:hivra-qa-mem-[0-9a-f]{32}$' and invalid.vmid <> 9302) is not true
    )
    and not exists (select 1 from qa_settings group by vmid having count(*) > 1)
    and not exists (
      select 1 from public.hivra_agents a
      where a.vmid = q.vmid and public.holder_admission_normalize_host_id(a.proxmox_host) = q.host_key
        and a.status is distinct from 'deleted'
    )
    and not exists (
      select 1 from public.hermes_instances h
      where h.proxmox_vmid = q.vmid and public.holder_admission_normalize_host_id(h.proxmox_node) = q.host_key
        and (h.deleted_at is null or h.lifecycle_state is distinct from 'deleted')
    )
  )
  select jsonb_build_object(
    'host_id', p.host_id,
    'qa_template_vmid', p.qa_template_vmid,
    'ratio_milli', p.ratio_milli,
    'valid_until_epoch', p.valid_until_epoch,
    'pressure_baseline', p.pressure_baseline,
    'measured_guests', coalesce((
      select jsonb_agg(guest.key order by guest.key)
      from (select key from managed_guests union all select key from qa_clones) guest
    ), '[]'::jsonb)
  )
  from permit p
  where p.valid_until_epoch > extract(epoch from statement_timestamp())
    and p.pressure_baseline is not null
    and (select count(*) from managed_guests) <= 64;
$$;

revoke all on function public.get_hivra_canary_memory_overcommit(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.get_hivra_canary_memory_overcommit(text, text) to service_role;
