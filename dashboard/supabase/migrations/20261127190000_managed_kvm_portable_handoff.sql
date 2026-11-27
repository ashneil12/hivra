set local lock_timeout = '2s';

create schema hivra_kvm_portable_private;
revoke all on schema hivra_kvm_portable_private from public, anon, authenticated, service_role;

create table hivra_kvm_portable_private.handoff (
  agent_id uuid not null,
  owner_id text not null,
  operation_id uuid primary key,
  generation bigint not null,
  source jsonb not null,
  destination jsonb not null,
  cpu numeric not null,
  ram_mb numeric not null,
  expires_at timestamptz not null,
  phase text not null default 'checkpointing' check (phase in (
    'checkpointing','storage_verified','restore_claimed','destination_verified',
    'committing','placement_committed','connector_verified','finishing','finished','aborting','aborted'
  )),
  checkpoint_sha256 text,
  storage_evidence jsonb,
  destination_evidence jsonb,
  commit_evidence jsonb,
  connector_evidence jsonb,
  wake_evidence jsonb,
  retirement_evidence jsonb,
  abort_evidence jsonb,
  retired_at timestamptz,
  active_agent_id uuid generated always as (case when retired_at is null then agent_id end) stored
    references public.hivra_agents(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (agent_id,generation),
  check ((retired_at is null)=(retirement_evidence is null and abort_evidence is null)),
  check (retirement_evidence is null or phase='finished'),
  check ((phase='aborted')=(abort_evidence is not null))
);
create unique index hivra_kvm_portable_one_unretired on hivra_kvm_portable_private.handoff ((true))
  where retired_at is null;
alter table hivra_kvm_portable_private.handoff enable row level security;
revoke all on table hivra_kvm_portable_private.handoff from public, anon, authenticated, service_role;

create function hivra_kvm_portable_private.valid_target(p_target jsonb)
returns boolean language plpgsql immutable set search_path=pg_catalog,pg_temp as $$
declare ip_address inet;
begin
  if jsonb_typeof(p_target) is distinct from 'object'
    or (p_target->>'hostId' ~ '^[a-z0-9][a-z0-9_-]{0,63}$') is not true
    or (p_target->>'vmid' ~ '^[1-9][0-9]{2,8}$') is not true
    or (p_target->>'bindingTag' ~ '^hivra-bind-[0-9a-f]{32}$') is not true
    or (p_target->>'ip' ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$') is not true
  then return false; end if;
  ip_address := (p_target->>'ip')::inet;
  return p_target=jsonb_build_object('hostId',p_target->>'hostId','vmid',(p_target->>'vmid')::integer,
    'ip',host(ip_address),'bindingTag',p_target->>'bindingTag');
exception when invalid_text_representation then
  return false;
end $$;

create function hivra_kvm_portable_private.agent_target(a public.hivra_agents)
returns jsonb language sql immutable set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('hostId',a.proxmox_host,'vmid',a.vmid,'ip',a.ip,
    'bindingTag','hivra-bind-'||left(a.infrastructure_binding_token_hash,32))
$$;

create function hivra_kvm_portable_private.guard_agent()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  h hivra_kvm_portable_private.handoff%rowtype;
  lease_fields text[] := array['operation_id','operation_kind','operation_started_at','operation_payload',
    'sleep_state','sleep_generation','sleep_tier_changed_at','next_wake_at'];
begin
  select * into h from hivra_kvm_portable_private.handoff
    where retired_at is null and agent_id=old.id and phase<>'finished';
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='UPDATE' then
    if h.phase='committing'
      and hivra_kvm_portable_private.agent_target(old)=h.source
      and hivra_kvm_portable_private.agent_target(new)=h.destination
      and to_jsonb(old)-array['proxmox_host','vmid','ip']=to_jsonb(new)-array['proxmox_host','vmid','ip']
    then return new; end if;
    if h.phase='finishing' and hivra_kvm_portable_private.agent_target(old)=h.destination
      and new.operation_id is null and new.operation_kind is null
      and new.sleep_state='awake' and new.sleep_generation=h.generation+1
      and to_jsonb(old)-lease_fields=to_jsonb(new)-lease_fields
    then return new; end if;
    if h.phase='aborting'
      and hivra_kvm_portable_private.agent_target(old)=h.source
      and old.operation_id=h.operation_id and old.operation_kind='wake'
      and old.sleep_state='waking' and old.sleep_generation=h.generation
      and new.operation_id is null and new.operation_kind is null
      and new.sleep_state='hibernated' and new.sleep_generation=h.generation+1
      and new.sleep_memory_dropped_at=new.sleep_tier_changed_at and new.next_wake_at is null
      and to_jsonb(old)-(lease_fields||array['sleep_memory_dropped_at'])
        =to_jsonb(new)-(lease_fields||array['sleep_memory_dropped_at'])
    then return new; end if;
  end if;
  raise exception 'legacy mutation refused during a portable KVM handoff' using errcode='55000';
end $$;

create trigger guard_hivra_kvm_portable_agent before update or delete on public.hivra_agents
  for each row execute function hivra_kvm_portable_private.guard_agent();

create function hivra_kvm_portable_private.guard_reserved_target()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  h hivra_kvm_portable_private.handoff%rowtype;
  host_id text;
  target_vmid integer;
  target_ip text;
  target jsonb;
begin
  if tg_table_name='hivra_agents' then
    if new.deployment_target_id is not null or new.status='deleted' then return new; end if;
    host_id := new.proxmox_host;
    target_vmid := new.vmid;
    target_ip := new.ip;
    if tg_op='UPDATE' and (old.proxmox_host,old.vmid,old.ip,old.deployment_target_id,old.status='deleted')
      is not distinct from (host_id,target_vmid,target_ip,new.deployment_target_id,false) then return new; end if;
  else
    if new.infrastructure_provider is distinct from 'proxmox' or new.deleted_at is not null then return new; end if;
    host_id := new.proxmox_node;
    target_vmid := new.proxmox_vmid;
    if tg_op='UPDATE' and (old.proxmox_node,old.proxmox_vmid,old.infrastructure_provider,old.deleted_at)
      is not distinct from (host_id,target_vmid,new.infrastructure_provider,new.deleted_at) then return new; end if;
  end if;
  if host_id is null or target_vmid is null then return new; end if;
  if tg_table_name='hivra_agents' or target_vmid between 9300 and 9399 then
    perform pg_advisory_xact_lock(hashtextextended('hivra-kvm-portable-target:'||host_id,0));
  end if;
  select * into h from hivra_kvm_portable_private.handoff where retired_at is null;
  if not found then return new; end if;
  for target in select h.source union all select h.destination where h.phase<>'finished'
  loop
    if host_id=target->>'hostId' and (target_vmid=(target->>'vmid')::int or target_ip=target->>'ip') then
      if tg_table_name='hivra_agents' and tg_op='UPDATE' and h.phase='committing' then
        if new.id=h.agent_id and target=h.destination
          and hivra_kvm_portable_private.agent_target(new)=h.destination then return new; end if;
      end if;
      raise exception 'placement is reserved by a portable KVM handoff' using errcode='P0058';
    end if;
  end loop;
  return new;
end $$;

create trigger guard_hivra_kvm_portable_target before insert or update on public.hivra_agents
  for each row execute function hivra_kvm_portable_private.guard_reserved_target();
create trigger guard_hermes_kvm_portable_target before insert or update on public.hermes_instances
  for each row execute function hivra_kvm_portable_private.guard_reserved_target();

create function hivra_kvm_portable_private.guard_auxiliary()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform 1 from public.hivra_agents where id=new.agent_id for key share;
  if exists (select 1 from hivra_kvm_portable_private.handoff
    where retired_at is null and agent_id=new.agent_id and phase<>'finished') then
    raise exception 'access mutation refused during a portable KVM handoff' using errcode='55000';
  end if;
  return new;
end $$;

create trigger guard_hivra_kvm_portable_ingress before insert or update on public.hivra_agent_ingress
  for each row execute function hivra_kvm_portable_private.guard_auxiliary();
create trigger guard_hivra_kvm_portable_channel before insert or update on public.hivra_agent_channel_wake
  for each row when (new.enabled or new.state<>'idle') execute function hivra_kvm_portable_private.guard_auxiliary();
create trigger guard_hivra_kvm_portable_telegram before insert or update on public.hivra_agent_telegram_wake
  for each row when (new.enabled or new.state<>'idle') execute function hivra_kvm_portable_private.guard_auxiliary();

create trigger guard_hivra_kvm_portable_private_access before insert or update on public.hivra_private_access_connections
  for each row when (new.state<>'disconnected') execute function hivra_kvm_portable_private.guard_auxiliary();

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
  )
  select c.host_id, c.cpu-coalesce(o.cpu,0)-coalesce(r.cpu,0)-coalesce(k.cpu,0),
         c.ram_mb-coalesce(o.ram,0)-coalesce(r.ram,0)-coalesce(k.ram_mb,0),
         coalesce(m.measured-coalesce(k.pending_disk,0), c.disk_gb-coalesce(o.disk,0)-coalesce(k.disk,0))
           - coalesce(r.seats,0)*d.needed,
         d.needed
  from public.holder_admission_host_capacity(p_targets,p_ratio) c
  left join actual o on o.host_id=c.host_id
  left join reservations r on r.assigned_host_id=c.host_id
  left join portable k on k.host_id=c.host_id
  cross join lateral (select public.holder_admission_measured_free_disk_gb(c.capacity_reading,o.launching) measured) m
  cross join lateral (select case when m.measured is not null then 20 else greatest(40,
    coalesce((p_disk_sizes->>public.holder_admission_normalize_host_id(c.host_id))::numeric,
             (p_disk_sizes->>'defaultDiskGb')::numeric)) end needed) d;
$$;

create function public.read_hivra_kvm_portable_handoff(p_owner_id text,p_agent_id uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select to_jsonb(h)-array['active_agent_id','cpu','ram_mb'] from hivra_kvm_portable_private.handoff h
  where h.owner_id=p_owner_id and h.agent_id=p_agent_id and h.retired_at is null
$$;

create function public.begin_hivra_kvm_portable_handoff(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_expected_generation bigint,
  p_source jsonb,p_destination jsonb,p_expires_at timestamptz
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  target_host text := p_destination->>'hostId';
  target_vmid int;
  capacity record;
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
  if target_vmid not between 9300 and 9399 or target_vmid=9302
    or (p_source->>'vmid')::int not between 9300 and 9399 or (p_source->>'vmid')::int=9302
  then return null; end if;

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

  perform pg_advisory_xact_lock(hashtextextended('hivra-kvm-portable-target:'||target_host,0));
  perform 1 from public.proxmox_hosts where id in (a.proxmox_host,target_host)
    and status='active' and decommissioned_at is null order by id for share;
  if not found or (select count(*) from public.proxmox_hosts where id in (a.proxmox_host,target_host)
      and status='active' and decommissioned_at is null)<>2
    or exists (select 1 from public.hivra_agents other where other.proxmox_host=target_host
      and other.status<>'deleted' and other.deployment_target_id is null
      and (other.vmid=target_vmid or other.ip=p_destination->>'ip'))
    or exists (select 1 from public.hermes_instances other where other.proxmox_node=target_host
      and other.infrastructure_provider='proxmox' and other.deleted_at is null and other.proxmox_vmid=target_vmid)
  then return null; end if;

  perform public.assert_proxmox_placement_capacity(target_host,p_owner_id,'paid',a.cpu,a.ram::numeric*1024,40,a.id);
  select * into capacity from public.holder_admission_host_availability(
    array[target_host],null,false,'{"defaultDiskGb":40}'::jsonb,null
  ) where host_id=target_host;
  if not found or capacity.free_disk_gb is null or capacity.free_disk_gb<40 then return null; end if;

  update public.hivra_agents set operation_id=p_operation_id,operation_kind='wake',
    operation_started_at=clock_timestamp(),operation_payload='{"portable_kvm":true}',
    sleep_state='waking',sleep_generation=p_expected_generation+1,sleep_tier_changed_at=clock_timestamp()
  where id=a.id;

  insert into hivra_kvm_portable_private.handoff
    (agent_id,owner_id,operation_id,generation,source,destination,cpu,ram_mb,expires_at)
  values (a.id,p_owner_id,p_operation_id,p_expected_generation+1,p_source,p_destination,
    a.cpu,a.ram::numeric*1024,p_expires_at);
  return public.read_hivra_kvm_portable_handoff(p_owner_id,p_agent_id);
end $$;

create function public.advance_hivra_kvm_portable_handoff(
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
      is distinct from ('wake',p_operation_id,'waking',p_generation,'running','running')
    or hivra_kvm_portable_private.agent_target(a) is distinct from
      (case when h.phase in ('placement_committed','connector_verified') then h.destination else h.source end)
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
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

  elsif p_action='claim_restore' and h.phase='storage_verified' and p_evidence is null then
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
      and status='active' and decommissioned_at is null order by id for share;
    if p_evidence is distinct from (source_proof||jsonb_build_object('destination',h.destination,
      'checkpointSha256',h.checkpoint_sha256,'destinationConnectorBlocked',true))
      or (select count(*) from public.proxmox_hosts where id in (h.source->>'hostId',h.destination->>'hostId')
          and status='active' and decommissioned_at is null)<>2
    then return null; end if;

    update hivra_kvm_portable_private.handoff set phase='committing' where operation_id=h.operation_id;
    perform public.assert_proxmox_placement_capacity(h.destination->>'hostId',p_owner_id,'paid',h.cpu,h.ram_mb,40,a.id);
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

create function public.finish_hivra_kvm_portable_retirement(
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
    and status='active' and decommissioned_at is null for share;
  if not found then return null; end if;

  update hivra_kvm_portable_private.handoff set retired_at=clock_timestamp(),
    retirement_evidence=p_evidence,updated_at=clock_timestamp() where operation_id=h.operation_id
    returning * into h;
  return to_jsonb(h)-array['active_agent_id','cpu','ram_mb'];
end $$;

create function public.abort_hivra_kvm_portable_handoff(
  p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,p_evidence jsonb
)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  h hivra_kvm_portable_private.handoff%rowtype;
  pre_cas constant text[] := array['checkpointing','storage_verified','restore_claimed','destination_verified'];
  cold_at timestamptz;
begin
  if not exists (select 1 from hivra_kvm_portable_private.handoff where retired_at is null and phase=any(pre_cas)
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation))
  then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found then return null; end if;
  select * into h from hivra_kvm_portable_private.handoff where retired_at is null and phase=any(pre_cas)
    and (owner_id,agent_id,operation_id,generation)=(p_owner_id,p_agent_id,p_operation_id,p_generation) for update;
  if not found
    or p_evidence is distinct from jsonb_build_object('source',h.source,'destination',h.destination,
      'portableWorkQuiesced',true,'destinationVmAbsent',true,'destinationStorageAbsent',true,
      'sourceDiskUnchanged',true,'sourceStopped',true,'sourceConnectorOff',true,'sourceLegacyColdMarkerRestored',true)
    or hivra_kvm_portable_private.agent_target(a) is distinct from h.source
    or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation,a.status,a.desired_state)
      is distinct from ('wake',h.operation_id,'waking',h.generation,'running','running')
    or a.operation_payload is distinct from '{"portable_kvm":true}'::jsonb
    or a.deployment_mode is distinct from 'hivra-managed' or a.computer_substrate is distinct from 'proxmox-kvm'
    or a.deployment_target_id is not null or a.infrastructure_binding_token_enforced is not true
    or exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id)
  then return null; end if;

  cold_at := clock_timestamp();
  update hivra_kvm_portable_private.handoff set phase='aborting' where operation_id=h.operation_id;
  update public.hivra_agents set operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null,
    sleep_state='hibernated',sleep_generation=h.generation+1,sleep_tier_changed_at=cold_at,
    sleep_memory_dropped_at=cold_at,next_wake_at=null
    where id=a.id and user_id=p_owner_id and operation_id=h.operation_id and sleep_generation=h.generation;
  if not found then raise exception 'portable KVM source lease changed during abort' using errcode='55000'; end if;
  update hivra_kvm_portable_private.handoff set phase='aborted',abort_evidence=p_evidence,
    retired_at=cold_at,updated_at=cold_at where operation_id=h.operation_id
    returning * into h;
  return to_jsonb(h)-array['active_agent_id','cpu','ram_mb'];
end $$;

revoke all on all functions in schema hivra_kvm_portable_private from public, anon, authenticated, service_role;
revoke all on function public.read_hivra_kvm_portable_handoff(text,uuid),
  public.begin_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,jsonb,jsonb,timestamptz),
  public.advance_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,text,jsonb),
  public.finish_hivra_kvm_portable_retirement(text,uuid,uuid,bigint,jsonb),
  public.abort_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,jsonb)
  from public, anon, authenticated;
grant execute on function public.read_hivra_kvm_portable_handoff(text,uuid),
  public.begin_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,jsonb,jsonb,timestamptz),
  public.advance_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,text,jsonb),
  public.finish_hivra_kvm_portable_retirement(text,uuid,uuid,bigint,jsonb),
  public.abort_hivra_kvm_portable_handoff(text,uuid,uuid,bigint,jsonb)
  to service_role;
