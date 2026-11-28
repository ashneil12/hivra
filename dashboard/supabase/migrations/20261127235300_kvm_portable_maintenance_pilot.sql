create table hivra_kvm_portable_private.maintenance_pilot (
  singleton boolean primary key default true check (singleton),
  owner_id text not null check (owner_id ~ '^user_[A-Za-z0-9]+$'),
  agent_id uuid not null,
  placement jsonb not null check (hivra_kvm_portable_private.valid_target(placement)),
  expires_at timestamptz not null check (isfinite(expires_at)),
  customer_health_checked_at timestamptz not null check (isfinite(customer_health_checked_at))
);
alter table hivra_kvm_portable_private.maintenance_pilot enable row level security;
revoke all on table hivra_kvm_portable_private.maintenance_pilot from public, anon, authenticated, service_role;

create function hivra_kvm_portable_private.host_allowed(
  p_owner_id text,p_agent_id uuid,p_placement jsonb,p_fresh boolean default true
)
returns boolean language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select exists (
    select 1 from public.proxmox_hosts h where h.id=p_placement->>'hostId' and h.decommissioned_at is null
      and (h.status='active' or (h.status='maintenance' and exists (
        select 1
        from hivra_kvm_portable_private.maintenance_pilot s
        join public.hivra_agents a on a.id=s.agent_id and a.user_id=s.owner_id
        where s.owner_id=p_owner_id and s.agent_id=p_agent_id and s.placement=p_placement
          and a.deployment_mode='hivra-managed' and a.computer_substrate='proxmox-kvm'
          and a.deployment_target_id is null and a.seat_funding='paid' and a.status='running'
          and a.infrastructure_binding_token_enforced
          and s.placement->>'bindingTag'='hivra-bind-'||left(a.infrastructure_binding_token_hash,32)
          and (not p_fresh or (s.expires_at>statement_timestamp()
            and s.expires_at<=statement_timestamp()+interval '4 hours'
            and s.customer_health_checked_at between statement_timestamp()-interval '10 minutes' and statement_timestamp()))
      )))
  );
$$;

create function public.check_hivra_kvm_portable_host(p_owner_id text,p_agent_id uuid,p_placement jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select hivra_kvm_portable_private.valid_target(p_placement)
    and hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_placement);
$$;
revoke all on function public.check_hivra_kvm_portable_host(text,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.check_hivra_kvm_portable_host(text,uuid,jsonb) to service_role;

create or replace function hivra_kvm_portable_private.host_capacity(
  p_target_host_ids text[],
  p_cpu_overcommit_ratio numeric,
  p_maintenance_host text
)
returns table(
  host_id text,
  cpu numeric,
  ram_mb numeric,
  disk_gb numeric,
  capacity_reading jsonb
)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  select h.id,
         greatest((h.total_cpu::numeric - h.reserved_cpu::numeric) *
           (case
              when h.cpu_overcommit_ratio is not null and h.cpu_overcommit_ratio > 0 and h.cpu_overcommit_ratio <= 20
                then h.cpu_overcommit_ratio::numeric
              when p_cpu_overcommit_ratio is not null and p_cpu_overcommit_ratio >= 1
                then p_cpu_overcommit_ratio::numeric
              else 5::numeric
            end), 0),
         greatest(h.total_ram_mb::numeric - h.reserved_ram_mb::numeric - h.wake_headroom_ram_mb::numeric, 0),
         case
           when h.thinpool_size_gb is null then null
           else h.thinpool_size_gb::numeric * coalesce(h.thinpool_overcommit_ratio, 1.5)::numeric
         end,
         h.capacity_reading
  from public.proxmox_hosts h
  where (h.status='active' or (h.id=p_maintenance_host and h.status='maintenance'))
    and h.decommissioned_at is null
    and h.total_cpu > h.reserved_cpu
    and h.total_ram_mb > h.reserved_ram_mb + h.wake_headroom_ram_mb
    and (
      p_target_host_ids is null
      or exists (
        select 1
        from unnest(p_target_host_ids) target(id)
        where public.holder_admission_normalize_host_id(h.id) = public.holder_admission_normalize_host_id(target.id)
      )
    );
$$;

create or replace function hivra_kvm_portable_private.placement_accounting(p_targets text[], p_skip_sleep boolean,p_maintenance_host text)
returns table(host_id text, owner_id text, holder boolean, cpu numeric, ram_mb numeric, disk_gb numeric, launching integer, launched_cpu numeric, launched_ram_mb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with hosts as (
    select c.host_id, h.placement_skip_deep_sleep
    from hivra_kvm_portable_private.host_capacity(p_targets,null,p_maintenance_host) c
    join public.proxmox_hosts h on h.id = c.host_id
  )
  select h.proxmox_node, h.user_id, h.seat_funding = 'holder',
         case when saved.reusable then 0 else h.cpu_limit::numeric end,
         case when saved.reusable then 0 else h.ram_limit::numeric end,
         coalesce(h.disk_size_gb,30)::numeric, case when h.lifecycle_state = 'provisioning' then 1 else 0 end, h.cpu_limit::numeric, h.ram_limit::numeric
  from public.hermes_instances h join hosts on hosts.host_id = h.proxmox_node
  cross join lateral (select h.seat_funding='holder' and h.lifecycle_state='paused' and h.paused_reason='holder_idle'
    and h.lifecycle_substate='holder_hibernated' and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false)) as reusable) saved
  where h.lifecycle_state in ('provisioning','active') or
    (h.lifecycle_state='paused' and h.seat_funding='holder' and h.paused_reason='holder_idle')
  union all
  select a.proxmox_host, a.user_id, a.seat_funding = 'holder',
         case when powered.holds_compute then sz.cpu else 0 end,
         case when powered.holds_compute then sz.ram_mb else 0 end,
         40::numeric, case when a.status = 'provisioning' then 1 else 0 end,
         case when a.status in ('running','provisioning') then sz.cpu else 0 end,
         case when a.status in ('running','provisioning') then sz.ram_mb else 0 end
  from public.hivra_agents a join hosts on hosts.host_id = a.proxmox_host
  cross join lateral public.holder_hivra_size(a.cpu,a.ram,a.operation_kind,a.operation_payload) sz
  cross join lateral (select a.status in ('running','provisioning')
    and not (a.sleep_state is not distinct from 'hibernated'
             and (p_skip_sleep or coalesce(hosts.placement_skip_deep_sleep,false))) as holds_compute) powered
  where a.status <> 'deleted' and (a.status in ('running','provisioning') or a.vmid is not null);
$$;

create or replace function hivra_kvm_portable_private.host_availability(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb, p_ignore_user_id text,p_maintenance_host text
)
returns table(host_id text, free_cpu numeric, free_ram_mb numeric, free_disk_gb numeric, needed_disk_gb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with occupied as materialized (select * from hivra_kvm_portable_private.placement_accounting(p_targets,p_skip_sleep,p_maintenance_host)),
  actual as (
    select o.host_id, sum(o.cpu) cpu, sum(o.ram_mb) ram, sum(o.disk_gb) disk, sum(o.launching)::int launching
    from occupied o group by o.host_id
  ), powered as (
    select o.owner_id, sum(o.launched_cpu) cpu, sum(o.launched_ram_mb) ram
    from occupied o where o.holder group by o.owner_id
  ), reservations as (
    select a.assigned_host_id, sum(greatest(a.reserved_cpu-coalesce(p.cpu,0),0)) cpu,
           sum(greatest(a.reserved_ram_mb-coalesce(p.ram,0),0)) ram,
           count(*) filter (where a.reserved_cpu > u.cpu or a.reserved_ram_mb > u.ram_mb or not exists (
             select 1 from occupied o where o.holder and o.owner_id=a.user_id and o.host_id=a.assigned_host_id and o.disk_gb>0
           )) seats
    from public.holder_admissions a left join powered p on p.owner_id=a.user_id
    cross join lateral public.holder_admission_existing_usage(a.user_id) u
    where a.state='admitted' and a.user_id is distinct from p_ignore_user_id
      and (a.reserved_cpu > coalesce(p.cpu,0) or a.reserved_ram_mb > coalesce(p.ram,0))
    group by a.assigned_host_id
  ), portable as (
    select h.destination->>'hostId' host_id, h.cpu, h.ram_mb, 40 disk, 40 pending_disk
    from hivra_kvm_portable_private.handoff h
    where h.retired_at is null and h.phase in ('checkpointing','storage_verified','restore_claimed','destination_verified')
    union all
    select h.source->>'hostId', 0, 0, 40, 0 from hivra_kvm_portable_private.handoff h
    where h.retired_at is null and h.phase in ('placement_committed','connector_verified','finishing','finished')
  ), standby as (
    select s.host_id, s.ready_at,
           greatest(s.cpu - case when live.compute then sz.cpu else 0 end,0) cpu,
           greatest(s.ram_mb - case when live.compute then sz.ram_mb else 0 end,0) ram,
           case when a.id is null then s.disk_gb else 0 end disk,
           case when a.status = 'provisioning' then 0 else 20 end pending_disk
    from hivra_hermes_standby_private.slot s
    join public.proxmox_hosts h on h.id=s.host_id
    left join public.hivra_agents a on a.id=s.claimed_agent_id and a.user_id=s.eligible_owner_id
      and a.proxmox_host=s.host_id and a.seat_funding='paid'
      and (a.operation_id=s.claimed_operation_id or a.allocation_operation_id=s.claimed_operation_id)
      and (a.vmid is null or a.vmid=s.vmid) and (a.ip is null or a.ip=host(s.private_ip))
      and a.status<>'deleted' and (a.status in ('running','provisioning') or a.vmid is not null)
    cross join lateral public.holder_hivra_size(a.cpu,a.ram,a.operation_kind,a.operation_payload) sz
    cross join lateral (select a.status in ('running','provisioning')
      and not (a.sleep_state is not distinct from 'hibernated'
        and (p_skip_sleep or coalesce(h.placement_skip_deep_sleep,false))) as compute) live
    where s.state in ('reserved','available','claimed','quarantined')
  )
  select c.host_id, c.cpu-coalesce(o.cpu,0)-coalesce(r.cpu,0)-coalesce(k.cpu,0)-coalesce(s.cpu,0),
         c.ram_mb-coalesce(o.ram,0)-coalesce(r.ram,0)-coalesce(k.ram_mb,0)-coalesce(s.ram,0),
         coalesce(m.measured-coalesce(k.pending_disk,0)-case
           when m.measured is not null and (c.capacity_reading->>'at')::timestamptz > s.ready_at then 0
           else coalesce(s.pending_disk,0) end,
           c.disk_gb-coalesce(o.disk,0)-coalesce(k.disk,0)-coalesce(s.disk,0))
           - coalesce(r.seats,0)*d.needed,
         d.needed
  from hivra_kvm_portable_private.host_capacity(p_targets,p_ratio,p_maintenance_host) c
  left join actual o on o.host_id=c.host_id
  left join reservations r on r.assigned_host_id=c.host_id
  left join portable k on k.host_id=c.host_id
  left join standby s on s.host_id=c.host_id
  cross join lateral (select public.holder_admission_measured_free_disk_gb(c.capacity_reading,o.launching) measured) m
  cross join lateral (select case when m.measured is not null then 20 else greatest(40,
    coalesce((p_disk_sizes->>public.holder_admission_normalize_host_id(c.host_id))::numeric,
             (p_disk_sizes->>'defaultDiskGb')::numeric)) end needed) d;
$$;

create function hivra_kvm_portable_private.assert_portable_capacity(
  p_owner_id text,p_agent_id uuid,p_target jsonb,p_cpu numeric,p_ram_mb numeric,p_placing boolean
)
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp
as $$
declare
  h text := p_target->>'hostId';
  host_status text;
  avail record;
begin
  select status into host_status from public.proxmox_hosts where id=h and decommissioned_at is null for share;
  if not found or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_target) then
    raise exception 'portable KVM host is not authorized' using errcode='P0058';
  end if;
  if host_status='active' then
    perform public.assert_proxmox_placement_capacity(h,p_owner_id,'paid',p_cpu,p_ram_mb,40,p_agent_id);
    if not p_placing then return; end if;
    select * into avail from public.holder_admission_host_availability(
      array[h],null,false,'{"defaultDiskGb":40}'::jsonb,null
    ) where host_id=h;
  else
    select * into avail from hivra_kvm_portable_private.host_availability(
      array[h],null,false,'{"defaultDiskGb":40}'::jsonb,null,h
    ) where host_id=h;
  end if;
  if not found or (avail.free_cpu >= p_cpu and avail.free_ram_mb >= p_ram_mb and avail.free_disk_gb >= 40) is not true then
    raise exception 'portable KVM host does not have sufficient CPU RAM and disk headroom' using errcode='P0058';
  end if;
end $$;

revoke all on function hivra_kvm_portable_private.host_allowed(text,uuid,jsonb,boolean),
  hivra_kvm_portable_private.host_capacity(text[],numeric,text),
  hivra_kvm_portable_private.placement_accounting(text[],boolean,text),
  hivra_kvm_portable_private.host_availability(text[],numeric,boolean,jsonb,text,text),
  hivra_kvm_portable_private.assert_portable_capacity(text,uuid,jsonb,numeric,numeric,boolean)
  from public, anon, authenticated, service_role;

create or replace function hivra_kvm_portable_private.enroll_pilot(
  p_owner_id text,p_agent_id uuid,p_placement_a jsonb,p_placement_b jsonb,p_evidence jsonb
)
returns boolean language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
begin
  if p_owner_id is null or btrim(p_owner_id)='' or p_agent_id is null
    or not hivra_kvm_portable_private.valid_target(p_placement_a)
    or not hivra_kvm_portable_private.valid_target(p_placement_b)
    or public.holder_admission_normalize_host_id(p_placement_a->>'hostId')=
       public.holder_admission_normalize_host_id(p_placement_b->>'hostId')
    or p_placement_a->>'vmid'='9302' or p_placement_b->>'vmid'='9302'
    or p_placement_a->>'bindingTag'<>p_placement_b->>'bindingTag'
    or p_evidence is distinct from jsonb_build_object('placementA',p_placement_a,'placementB',p_placement_b,
      'placementAReservedForBinding',true,'placementBReservedForBinding',true)
  then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id
    and deployment_mode='hivra-managed' and computer_substrate='proxmox-kvm' and deployment_target_id is null
    and computer_profile is distinct from 'windows' and type<>'windows' and seat_funding='paid'
    and canary_qa_holder_expires_at is null and status='running' and desired_state='running' and operation_id is null
    and infrastructure_binding_token_enforced and infrastructure_binding_token_hash ~ '^[0-9a-f]{64}$'
    for update;
  if not found or hivra_kvm_portable_private.agent_target(a) not in (p_placement_a,p_placement_b)
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
    or exists (select 1 from hivra_kvm_portable_private.handoff where retired_at is null and agent_id=p_agent_id)
  then return false; end if;
  perform 1 from public.proxmox_hosts where id in (p_placement_a->>'hostId',p_placement_b->>'hostId')
    order by id for share;
  if not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_placement_a)
    or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_placement_b)
  then return false; end if;

  insert into hivra_kvm_portable_private.pilot_enrollment(owner_id,agent_id,placement_a,placement_b,binding_token_hash)
    values (p_owner_id,p_agent_id,p_placement_a,p_placement_b,a.infrastructure_binding_token_hash)
    on conflict (singleton) do nothing;
  return found;
end $$;

create or replace function public.begin_hivra_kvm_portable_handoff(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_expected_generation bigint,
  p_source jsonb,p_destination jsonb,p_expires_at timestamptz
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  target_host text := p_destination->>'hostId';
  source_host text := p_source->>'hostId';
  target_vmid int;
  source_vmid int;
  lock_target record;
begin
  if p_owner_id is null or btrim(p_owner_id)=''
    or p_agent_id is null or p_operation_id is null or p_expected_generation is null
    or p_expected_generation not between 0 and 9223372036854775805
    or p_expires_at is null or not isfinite(p_expires_at)
    or not hivra_kvm_portable_private.valid_target(p_source)
    or not hivra_kvm_portable_private.valid_target(p_destination)
    or public.holder_admission_normalize_host_id(p_source->>'hostId')=public.holder_admission_normalize_host_id(target_host)
    or p_source->>'bindingTag'<>p_destination->>'bindingTag'
  then return null; end if;
  target_vmid := (p_destination->>'vmid')::int;
  source_vmid := (p_source->>'vmid')::int;
  if target_vmid=9302 or source_vmid=9302 then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  if p_expires_at<=clock_timestamp() or p_expires_at>clock_timestamp()+interval '24 hours'
    or exists (select 1 from hivra_kvm_portable_private.handoff
      where retired_at is null or operation_id=p_operation_id
        or (agent_id=p_agent_id and generation>=p_expected_generation+1))
  then return null; end if;

  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id
    and deployment_mode='hivra-managed' and computer_substrate='proxmox-kvm'
    and deployment_target_id is null and computer_profile is distinct from 'windows'
    and type<>'windows' and seat_funding='paid' and canary_qa_holder_expires_at is null
    and status='running' and desired_state='running' and operation_id is null
    and sleep_policy='full' and always_on is false and sleep_state='hibernated' and sleep_generation=p_expected_generation
    and sleep_memory_dropped_at>=sleep_tier_changed_at
    and sleep_stored_at is null and sleep_store_job_id is null
    and sleep_unstore_requested_at is null and sleep_unstore_job_id is null
    and next_wake_at is null and infrastructure_binding_token_enforced
    and nullif(cf_hostname,'') is not null and nullif(cf_tunnel_id,'') is not null and nullif(chat_url,'') is not null
    for update;
  if not found or hivra_kvm_portable_private.agent_target(a) is distinct from p_source then return null; end if;

  if exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
    or exists (select 1 from public.hivra_agent_ingress where agent_id=a.id)
    or exists (select 1 from public.hivra_agent_channel_wake where agent_id=a.id and (enabled or state<>'idle'))
    or exists (select 1 from public.hivra_agent_telegram_wake where agent_id=a.id and (enabled or state<>'idle'))
    or exists (select 1 from public.hivra_private_access_connections where agent_id=a.id and state<>'disconnected')
    or exists (select 1 from public.hivra_agent_attachments where computer_id=a.id and phase='claimed')
  then return null; end if;

  for lock_target in select host_id,vmid from (values (source_host,source_vmid),(target_host,target_vmid)) t(host_id,vmid)
    order by host_id
  loop
    perform pg_advisory_xact_lock(hashtextextended('hivra-kvm-portable-target:'||lock_target.host_id,0));
    if lock_target.vmid not between 9300 and 9399 then
      perform pg_advisory_xact_lock(hashtextextended(
        'hivra-kvm-portable-vmid:'||lock_target.host_id||':'||lock_target.vmid,0));
    end if;
  end loop;
  perform 1 from public.proxmox_hosts where id in (a.proxmox_host,target_host)
    order by id for share;
  if not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_source)
    or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,p_destination)
    or exists (select 1 from public.hivra_agents other where other.proxmox_host=target_host
      and other.status<>'deleted' and other.deployment_target_id is null
      and (other.vmid=target_vmid or other.ip=p_destination->>'ip'))
    or exists (select 1 from public.hermes_instances other where other.proxmox_node=target_host
      and other.infrastructure_provider='proxmox' and other.deleted_at is null and other.proxmox_vmid=target_vmid)
    or exists (select 1 from public.hermes_instances other where other.proxmox_node=source_host
      and other.infrastructure_provider='proxmox' and other.deleted_at is null and other.proxmox_vmid=source_vmid)
  then return null; end if;

  if target_vmid not between 9300 and 9399 or source_vmid not between 9300 and 9399
    or exists (select 1 from public.proxmox_hosts where id in (source_host,target_host) and status='maintenance')
  then
    perform 1 from hivra_kvm_portable_private.pilot_enrollment e
      where e.owner_id=p_owner_id and e.agent_id=p_agent_id and e.binding_token_hash=a.infrastructure_binding_token_hash
      and ((e.placement_a,e.placement_b)=(p_source,p_destination) or (e.placement_b,e.placement_a)=(p_source,p_destination))
      for share;
    if not found then return null; end if;
  end if;

  perform hivra_kvm_portable_private.assert_portable_capacity(
    p_owner_id,p_agent_id,p_destination,a.cpu,a.ram::numeric*1024,true);

  update public.hivra_agents set operation_id=p_operation_id,operation_kind='wake',
    operation_started_at=clock_timestamp(),operation_payload='{"portable_kvm":true}',
    sleep_generation=p_expected_generation+1
  where id=a.id;

  insert into hivra_kvm_portable_private.handoff
    (agent_id,owner_id,operation_id,generation,source,destination,cpu,ram_mb,expires_at)
  values (a.id,p_owner_id,p_operation_id,p_expected_generation+1,p_source,p_destination,
    a.cpu,a.ram::numeric*1024,p_expires_at);
  return public.read_hivra_kvm_portable_handoff(p_owner_id,p_agent_id);
end $$;

create or replace function public.request_hivra_kvm_portable_wake(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  h hivra_kvm_portable_private.handoff%rowtype;
  requested_at timestamptz;
begin
  if not exists (select 1 from hivra_kvm_portable_private.handoff where retired_at is null and phase<>'finished'
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation))
  then return null; end if;

  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found then return null; end if;
  select * into h from hivra_kvm_portable_private.handoff where retired_at is null and phase<>'finished'
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation) for update;
  if not found then return null; end if;
  requested_at := clock_timestamp();
  if not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.source)
    or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.destination)
    or h.expires_at<=requested_at
    or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation,a.status,a.desired_state)
      is distinct from ('wake',h.operation_id,
        case when h.wake_requested_at is null then 'hibernated' else 'waking' end,
        h.generation,'running','running')
    or a.operation_payload is distinct from '{"portable_kvm":true}'::jsonb
    or a.sleep_policy is distinct from 'full' or a.always_on is not false or a.next_wake_at is not null
    or hivra_kvm_portable_private.agent_target(a) is distinct from
      (case when h.phase in ('placement_committed','connector_verified') then h.destination else h.source end)
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
  then return null; end if;
  if h.wake_requested_at is not null then
    return public.read_hivra_kvm_portable_handoff(p_owner_id,p_agent_id);
  end if;
  if h.phase not in ('checkpointing','storage_verified')
    or (a.sleep_memory_dropped_at>=a.sleep_tier_changed_at) is not true
  then return null; end if;

  update hivra_kvm_portable_private.handoff set wake_requested_at=requested_at,updated_at=requested_at
    where operation_id=h.operation_id;
  update public.hivra_agents set sleep_state='waking',sleep_tier_changed_at=requested_at
    where id=a.id and user_id=p_owner_id and operation_id=h.operation_id and sleep_generation=h.generation;
  if not found then raise exception 'portable KVM source lease changed during wake request' using errcode='55000'; end if;
  return public.read_hivra_kvm_portable_handoff(p_owner_id,p_agent_id);
end $$;

create or replace function public.advance_hivra_kvm_portable_handoff(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,p_action text,p_evidence jsonb
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  h hivra_kvm_portable_private.handoff%rowtype;
  checkpoint text;
  source_proof jsonb;
  configuration jsonb := p_evidence->'configuration';
  disk jsonb := p_evidence->'disk';
  disk_bytes numeric;
  boot_id text := p_evidence->>'bootId';
  reservation_sha256 text := p_evidence->>'reservationSha256';
  connector_id text := p_evidence->>'connectorId';
begin
  if not exists (select 1 from hivra_kvm_portable_private.handoff
    where retired_at is null
      and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation))
  then return null; end if;

  if p_action='commit_placement' then perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0)); end if;
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found then return null; end if;
  select * into h from hivra_kvm_portable_private.handoff
    where retired_at is null
      and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation) for update;
  if not found or h.expires_at<=clock_timestamp() or h.phase='finished'
    or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation,a.status,a.desired_state)
      is distinct from ('wake',p_operation_id,
        case when h.wake_requested_at is null then 'hibernated' else 'waking' end,
        p_generation,'running','running')
    or a.operation_payload is distinct from '{"portable_kvm":true}'::jsonb
    or hivra_kvm_portable_private.agent_target(a) is distinct from
      (case when h.phase in ('placement_committed','connector_verified') then h.destination else h.source end)
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
  then return null; end if;

  if h.phase not in ('placement_committed','connector_verified')
    and (not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.source)
      or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.destination))
  then return null; end if;

  source_proof := jsonb_build_object('source',h.source,'sourceStopped',true,'sourceFenced',true,'sourceConnectorOff',true);

  if p_action='verify_storage' and h.phase='checkpointing' then
    checkpoint := p_evidence->>'checkpointSha256';
    if (checkpoint ~ '^[0-9a-f]{64}$') is not true
      or (configuration->>'snapshotId' ~ '^[0-9a-f]{64}$') is not true
      or (configuration->>'sha256' ~ '^[0-9a-f]{64}$') is not true
      or (disk->>'snapshotId' ~ '^[0-9a-f]{64}$') is not true
      or (disk->>'sha256' ~ '^[0-9a-f]{64}$') is not true
      or configuration->>'snapshotId'=disk->>'snapshotId'
      or jsonb_typeof(disk->'bytes') is distinct from 'number'
    then return null; end if;
    disk_bytes := (disk->>'bytes')::numeric;
    if disk_bytes not between 512 and 42949672960 or mod(disk_bytes,512)<>0
      or p_evidence is distinct from (source_proof||jsonb_build_object(
        'checkpointSha256',checkpoint,'storageReadbackVerified',true,
        'configuration',jsonb_build_object('snapshotId',configuration->>'snapshotId','sha256',configuration->>'sha256'),
        'disk',jsonb_build_object('key','scsi0','snapshotId',disk->>'snapshotId','sha256',disk->>'sha256','bytes',disk_bytes)))
    then return null; end if;
    update hivra_kvm_portable_private.handoff set phase='storage_verified',checkpoint_sha256=checkpoint,
      storage_evidence=p_evidence,updated_at=clock_timestamp() where operation_id=h.operation_id;

  elsif p_action='claim_restore' and h.phase='storage_verified' and h.wake_requested_at is not null and p_evidence is null then
    update hivra_kvm_portable_private.handoff set phase='restore_claimed',updated_at=clock_timestamp()
      where operation_id=h.operation_id;

  elsif p_action='verify_destination' and h.phase='restore_claimed' then
    if (boot_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is not true
      or (reservation_sha256 ~ '^[0-9a-f]{64}$') is not true
      or p_evidence is distinct from jsonb_build_object('destination',h.destination,'checkpointSha256',h.checkpoint_sha256,
        'coldBootVerified',true,'destinationConnectorBlocked',true,'bootId',boot_id,'reservationSha256',reservation_sha256)
    then return null; end if;
    update hivra_kvm_portable_private.handoff set phase='destination_verified',
      destination_evidence=p_evidence,updated_at=clock_timestamp() where operation_id=h.operation_id;

  elsif p_action='commit_placement' and h.phase='destination_verified' then
    perform 1 from public.proxmox_hosts where id in (h.source->>'hostId',h.destination->>'hostId')
      order by id for share;
    if p_evidence is distinct from (source_proof||jsonb_build_object('destination',h.destination,
      'checkpointSha256',h.checkpoint_sha256,'destinationConnectorBlocked',true))
      or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.source)
      or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.destination)
    then return null; end if;

    update hivra_kvm_portable_private.handoff set phase='committing' where operation_id=h.operation_id;
    perform hivra_kvm_portable_private.assert_portable_capacity(p_owner_id,p_agent_id,h.destination,h.cpu,h.ram_mb,false);
    update public.hivra_agents set proxmox_host=h.destination->>'hostId',vmid=(h.destination->>'vmid')::int,
      ip=h.destination->>'ip'
    where id=a.id and user_id=p_owner_id and operation_id=p_operation_id and sleep_generation=p_generation
      and hivra_kvm_portable_private.agent_target(hivra_agents)=h.source;
    if not found then raise exception 'portable KVM source changed during placement commit' using errcode='55000'; end if;
    update hivra_kvm_portable_private.handoff set phase='placement_committed',
      commit_evidence=p_evidence,updated_at=clock_timestamp() where operation_id=h.operation_id;

  elsif p_action='confirm_connector' and h.phase='placement_committed' then
    if boot_id is distinct from h.destination_evidence->>'bootId' or boot_id is null
      or (connector_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') is not true
      or p_evidence is distinct from jsonb_build_object('destination',h.destination,'sourceFenced',true,
        'sourceConnectorOff',true,'destinationConnectorReady',true,'bootId',boot_id,'connectorId',connector_id)
    then return null; end if;
    update hivra_kvm_portable_private.handoff set phase='connector_verified',connector_evidence=p_evidence,
      updated_at=clock_timestamp() where operation_id=h.operation_id;

  elsif p_action='finish_wake' and h.phase='connector_verified' then
    if h.connector_evidence is null or p_evidence is distinct from
      (h.connector_evidence||jsonb_build_object('destinationLockReleased',true))
    then return null; end if;
    update hivra_kvm_portable_private.handoff set phase='finishing' where operation_id=h.operation_id;
    if not public.finish_hivra_agent_wake(a.id,p_operation_id,'awake') then
      raise exception 'portable KVM wake lease could not be released' using errcode='55000';
    end if;
    update hivra_kvm_portable_private.handoff set phase='finished',wake_evidence=p_evidence,updated_at=clock_timestamp()
      where operation_id=h.operation_id;

  else
    return null;
  end if;
  return public.read_hivra_kvm_portable_handoff(p_owner_id,p_agent_id);
end $$;

create or replace function public.finish_hivra_kvm_portable_retirement(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,p_evidence jsonb
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  h hivra_kvm_portable_private.handoff%rowtype;
begin
  if not exists (select 1 from hivra_kvm_portable_private.handoff where retired_at is null and phase='finished'
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation))
  then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found then return null; end if;
  select * into h from hivra_kvm_portable_private.handoff where retired_at is null and phase='finished'
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation) for update;
  if not found
    or p_evidence is distinct from jsonb_build_object('source',h.source,'destination',h.destination,
      'sourceVmAbsent',true,'sourceConnectorAbsent',true,'destinationHealthy',true)
    or hivra_kvm_portable_private.agent_target(a) is distinct from h.destination
    or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation,a.status,a.desired_state)
      is distinct from (null::text,null::uuid,'awake',h.generation+1,'running','running')
    or a.deployment_mode is distinct from 'hivra-managed' or a.computer_substrate is distinct from 'proxmox-kvm'
    or a.deployment_target_id is not null or a.infrastructure_binding_token_enforced is not true
    or nullif(a.cf_hostname,'') is null or nullif(a.cf_tunnel_id,'') is null or nullif(a.chat_url,'') is null
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
  then return null; end if;
  perform 1 from public.proxmox_hosts where id=h.destination->>'hostId'
    and decommissioned_at is null for share;
  if not found or not hivra_kvm_portable_private.host_allowed(p_owner_id,p_agent_id,h.destination,false)
  then return null; end if;

  update hivra_kvm_portable_private.handoff set retired_at=clock_timestamp(),
    retirement_evidence=p_evidence,updated_at=clock_timestamp() where operation_id=h.operation_id
    returning * into h;
  return to_jsonb(h)-array['active_agent_id','cpu','ram_mb'];
end $$;
