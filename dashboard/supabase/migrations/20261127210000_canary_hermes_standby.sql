begin;

-- This ledger is for the single Canary standby experiment. It doesn't update
-- production's database or represent its workloads. On the shared host, the
-- host-local memory admission must count this guest through the same actual
-- VM inventory that includes production guests.
create schema hivra_hermes_standby_private;
revoke all on schema hivra_hermes_standby_private from public, anon, authenticated, service_role;

create table hivra_hermes_standby_private.slot (
  generation uuid primary key,
  host_id text not null check (host_id ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
  vmid integer not null check (vmid between 9300 and 9399 and vmid <> 9302),
  private_ip inet not null check (family(private_ip) = 4 and masklen(private_ip) = 32),
  baked_digest text not null check (baked_digest ~ '^[0-9a-f]{64}$'),
  eligible_owner_id text not null check (length(btrim(eligible_owner_id)) between 1 and 256),
  cpu numeric not null check (cpu > 0 and cpu < 'Infinity'::numeric),
  ram_mb integer not null check (ram_mb > 0 and ram_mb % 1024 = 0),
  disk_gb integer not null check (disk_gb = 40),
  expires_at timestamptz not null check (isfinite(expires_at)),
  state text not null default 'reserved'
    check (state in ('reserved', 'available', 'claimed', 'quarantined', 'assigned', 'released')),
  ready_at timestamptz,
  claimed_agent_id uuid,
  claimed_operation_id uuid unique,
  check ((claimed_agent_id is null) = (claimed_operation_id is null)),
  check (state not in ('claimed', 'assigned') or claimed_operation_id is not null)
);
create unique index hivra_hermes_standby_one_active
  on hivra_hermes_standby_private.slot ((true))
  where state in ('reserved', 'available', 'claimed', 'quarantined');
alter table hivra_hermes_standby_private.slot enable row level security;
revoke all on table hivra_hermes_standby_private.slot from public, anon, authenticated, service_role;

-- The ordinary agent row counts from the moment claim installs its host.
-- Deduct only the portion it doesn't already cover until verified transfer.
-- Expiry stops claims, not accounting; uncertain custody remains charged.
create or replace function public.holder_admission_host_availability(
  p_targets text[], p_ratio numeric, p_skip_sleep boolean, p_disk_sizes jsonb, p_ignore_user_id text
)
returns table(host_id text, free_cpu numeric, free_ram_mb numeric, free_disk_gb numeric, needed_disk_gb numeric)
language sql stable security definer set search_path=pg_catalog,pg_temp
as $$
  with occupied as materialized (select * from public.holder_placement_accounting(p_targets,p_skip_sleep)),
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
  from public.holder_admission_host_capacity(p_targets,p_ratio) c
  left join actual o on o.host_id=c.host_id
  left join reservations r on r.assigned_host_id=c.host_id
  left join portable k on k.host_id=c.host_id
  left join standby s on s.host_id=c.host_id
  cross join lateral (select public.holder_admission_measured_free_disk_gb(c.capacity_reading,o.launching) measured) m
  cross join lateral (select case when m.measured is not null then 20 else greatest(40,
    coalesce((p_disk_sizes->>public.holder_admission_normalize_host_id(c.host_id))::numeric,
             (p_disk_sizes->>'defaultDiskGb')::numeric)) end needed) d;
$$;

create function public.reserve_hivra_hermes_standby(
  p_owner_id text, p_host_id text, p_generation uuid, p_vmid integer, p_private_ip inet,
  p_baked_digest text, p_cpu numeric, p_ram_mb integer, p_disk_gb integer, p_expires_at timestamptz
)
returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare s hivra_hermes_standby_private.slot%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into s from hivra_hermes_standby_private.slot where generation=p_generation;
  if found then
    if (s.host_id,s.vmid,s.private_ip,s.baked_digest,s.eligible_owner_id,s.cpu,s.ram_mb,s.disk_gb,s.expires_at)
       is not distinct from (p_host_id,p_vmid,p_private_ip,p_baked_digest,p_owner_id,p_cpu,p_ram_mb,p_disk_gb,p_expires_at)
    then return s.state; end if;
    return 'generation_conflict';
  end if;

  if p_host_id is null or p_host_id !~ '^[a-z0-9][a-z0-9-]{0,31}$' or p_expires_at is null or p_expires_at <= clock_timestamp() then
    raise exception 'invalid Canary Hermes standby scope or expiry' using errcode='22023';
  end if;
  if exists (select 1 from hivra_hermes_standby_private.slot
      where state in ('reserved','available','claimed','quarantined')) then return 'busy'; end if;
  if exists (select 1 from public.hivra_agents a where a.proxmox_host=p_host_id
      and a.status<>'deleted' and (a.vmid=p_vmid or a.ip=host(p_private_ip)))
    or exists (select 1 from public.hermes_instances h where h.proxmox_node=p_host_id
      and h.deleted_at is null and (h.proxmox_vmid=p_vmid or h.ipv4_address=host(p_private_ip)))
    or exists (select 1 from hivra_kvm_portable_private.handoff h where h.retired_at is null and (
      (h.source->>'hostId'=p_host_id and (h.source->>'vmid'=p_vmid::text or h.source->>'ip'=host(p_private_ip)))
      or (h.destination->>'hostId'=p_host_id and (h.destination->>'vmid'=p_vmid::text or h.destination->>'ip'=host(p_private_ip)))))
  then return 'target_in_use'; end if;

  perform public.assert_proxmox_placement_capacity(p_host_id,p_owner_id,'paid',p_cpu,p_ram_mb,p_disk_gb);
  insert into hivra_hermes_standby_private.slot
    (generation,host_id,vmid,private_ip,baked_digest,eligible_owner_id,cpu,ram_mb,disk_gb,expires_at)
  values (p_generation,p_host_id,p_vmid,p_private_ip,p_baked_digest,p_owner_id,p_cpu,p_ram_mb,p_disk_gb,p_expires_at);
  return 'reserved';
end $$;

-- Operator readiness follows exact host boot verification. Release requires
-- independent proof that the exact VM and its disk are absent.
create function public.advance_hivra_hermes_standby(p_generation uuid, p_action text)
returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare s hivra_hermes_standby_private.slot%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into s from hivra_hermes_standby_private.slot where generation=p_generation for update;
  if not found then return 'no_match'; end if;
  if p_action='make_available' then
    if s.state='reserved' and s.expires_at > clock_timestamp() then
      update hivra_hermes_standby_private.slot set state='available',ready_at=clock_timestamp() where generation=p_generation;
      return 'available';
    end if;
  elsif p_action='quarantine' then
    if s.state in ('reserved','available','claimed') then
      update hivra_hermes_standby_private.slot set state='quarantined' where generation=p_generation;
      return 'quarantined';
    end if;
  elsif p_action='release_absent' and s.state='quarantined' then
    update hivra_hermes_standby_private.slot set state='released' where generation=p_generation;
    return 'released';
  end if;
  return s.state;
end $$;

create function public.read_hivra_hermes_standby(p_owner_id text, p_host_id text, p_baked_digest text)
returns jsonb language sql volatile security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('generation',s.generation,'vmid',s.vmid,'privateIp',host(s.private_ip),
    'cpu',s.cpu,'ramMb',s.ram_mb,'diskGb',s.disk_gb)
  from hivra_hermes_standby_private.slot s
  join public.holder_admission_host_capacity(array[p_host_id]) c on c.host_id=s.host_id
  where s.state='available' and s.expires_at > clock_timestamp()
    and s.eligible_owner_id=p_owner_id and s.host_id=p_host_id and s.baked_digest=p_baked_digest
$$;

create function public.claim_hivra_hermes_standby(
  p_owner_id text, p_agent_id uuid, p_operation_id uuid, p_host_id text,
  p_generation uuid, p_vmid integer, p_private_ip inet, p_baked_digest text
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  s hivra_hermes_standby_private.slot%rowtype;
  a public.hivra_agents%rowtype;
  no_match constant jsonb := '{"status":"no_match"}';
  in_doubt constant jsonb := '{"status":"claim_in_doubt"}';
  replay boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into s from hivra_hermes_standby_private.slot
    where claimed_operation_id=p_operation_id and eligible_owner_id=p_owner_id and claimed_agent_id=p_agent_id;
  replay := found;
  if not replay then
    select * into s from hivra_hermes_standby_private.slot
      where generation=p_generation and eligible_owner_id=p_owner_id;
    if not found then return no_match; end if;
  end if;

  if (s.generation,s.host_id,s.vmid,s.private_ip,s.baked_digest)
       is distinct from (p_generation,p_host_id,p_vmid,p_private_ip,p_baked_digest)
    or (replay and s.state not in ('claimed','assigned'))
    or (not replay and (s.state <> 'available' or s.expires_at <= clock_timestamp()
      or not exists(select 1 from public.holder_admission_host_capacity(array[p_host_id]) where host_id=p_host_id)))
  then return case when replay then in_doubt else no_match end; end if;
  if replay and s.state='assigned' then
    return jsonb_build_object('status','assigned');
  end if;

  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found or p_operation_id is null or a.operation_id is distinct from p_operation_id
    or a.operation_kind is distinct from 'provision' or a.status is distinct from 'provisioning'
    or a.desired_state is distinct from 'running' or a.sleep_state is distinct from 'awake'
    or a.type is distinct from 'hermes'
    or a.deployment_mode is distinct from 'hivra-managed' or a.seat_funding is distinct from 'paid'
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.computer_profile is not null
    or a.managed_provisioner_channel is distinct from 'canary'
    or a.infrastructure_binding_token_enforced is distinct from true
    or a.cpu is distinct from s.cpu or a.ram::numeric * 1024 is distinct from s.ram_mb
    or greatest(a.cpu,a.cpu_max) <> s.cpu or greatest(a.ram,a.ram_max)::numeric * 1024 <> s.ram_mb
    or (replay and (a.proxmox_host is distinct from s.host_id
      or ((a.vmid is not null or a.ip is not null or a.allocation_operation_id is not null)
        and (a.vmid,a.ip,a.allocation_operation_id) is distinct from (s.vmid,host(s.private_ip),p_operation_id))))
    or (not replay and (a.proxmox_host is distinct from '' or a.vmid is not null or a.ip is not null
      or a.allocation_operation_id is not null))
  then return case when replay then in_doubt else no_match end; end if;

  if not replay then
    update public.hivra_agents set proxmox_host=s.host_id where id=a.id;
    update hivra_hermes_standby_private.slot set state='claimed',claimed_agent_id=a.id,claimed_operation_id=p_operation_id
      where generation=s.generation;
  end if;
  return jsonb_build_object('status','claimed','vmid',s.vmid,'privateIp',host(s.private_ip));
end $$;

-- Only the existing identity write, after the host's exact allocation receipt,
-- proves this reservation can permanently defer to the ordinary agent ledger.
create function public.assign_hivra_hermes_standby(
  p_owner_id text, p_agent_id uuid, p_operation_id uuid, p_generation uuid
)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare s hivra_hermes_standby_private.slot%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into s from hivra_hermes_standby_private.slot where generation=p_generation
    and eligible_owner_id=p_owner_id and claimed_agent_id=p_agent_id and claimed_operation_id=p_operation_id for update;
  if not found then return false; end if;
  if s.state='assigned' then return true; end if;
  if s.state <> 'claimed' then return false; end if;
  perform 1 from public.hivra_agents a where a.id=p_agent_id and a.user_id=p_owner_id
    and a.operation_id=p_operation_id and a.operation_kind='provision'
    and a.allocation_operation_id=p_operation_id and a.proxmox_host=s.host_id
    and a.vmid=s.vmid and a.ip=host(s.private_ip) and a.status='provisioning'
    and a.desired_state='running' and a.sleep_state='awake'
    and a.seat_funding='paid' and a.deployment_mode='hivra-managed' and a.managed_provisioner_channel='canary'
    and a.computer_substrate='proxmox-kvm' and a.type='hermes' and a.computer_profile is null
    and a.infrastructure_binding_token_enforced
    and greatest(a.cpu,a.cpu_max)=s.cpu and greatest(a.ram,a.ram_max)::numeric*1024=s.ram_mb
    and a.cpu=s.cpu and a.ram::numeric*1024=s.ram_mb for update;
  if not found then return false; end if;
  update hivra_hermes_standby_private.slot set state='assigned' where generation=p_generation;
  return true;
end $$;

revoke all on function public.reserve_hivra_hermes_standby(text,text,uuid,integer,inet,text,numeric,integer,integer,timestamptz),
  public.advance_hivra_hermes_standby(uuid,text), public.read_hivra_hermes_standby(text,text,text),
  public.claim_hivra_hermes_standby(text,uuid,uuid,text,uuid,integer,inet,text),
  public.assign_hivra_hermes_standby(text,uuid,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.reserve_hivra_hermes_standby(text,text,uuid,integer,inet,text,numeric,integer,integer,timestamptz),
  public.advance_hivra_hermes_standby(uuid,text), public.read_hivra_hermes_standby(text,text,text),
  public.claim_hivra_hermes_standby(text,uuid,uuid,text,uuid,integer,inet,text),
  public.assign_hivra_hermes_standby(text,uuid,uuid,uuid) to service_role;

commit;
