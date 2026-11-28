set local lock_timeout = '2s';

create table hivra_kvm_portable_private.cleanup_hold (
  operation_id uuid primary key references hivra_kvm_portable_private.handoff(operation_id),
  agent_id uuid not null,
  receipt_id uuid not null unique default gen_random_uuid(),
  authority jsonb not null,
  finished_at timestamptz
);
alter table hivra_kvm_portable_private.cleanup_hold enable row level security;
revoke all on table hivra_kvm_portable_private.cleanup_hold from public, anon, authenticated, service_role;
create unique index kvm_portable_cleanup_one_active_per_agent
  on hivra_kvm_portable_private.cleanup_hold(agent_id) where finished_at is null;

create function hivra_kvm_portable_private.guard_cleanup_hold()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if tg_table_name='handoff' and tg_op='INSERT' then
    perform 1 from hivra_kvm_portable_private.pilot_enrollment
      where owner_id=new.owner_id or agent_id=new.agent_id for share;
    return new;
  end if;
  if tg_table_name='handoff' then
    if exists (select 1 from hivra_kvm_portable_private.cleanup_hold
        where operation_id=old.operation_id and finished_at is null)
    then raise exception 'portable KVM cleanup holds the handoff' using errcode='55000'; end if;
  else
    if exists (select 1 from hivra_kvm_portable_private.cleanup_hold
        where agent_id=old.id and finished_at is null)
    then raise exception 'portable KVM cleanup holds the agent' using errcode='55000'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create trigger guard_hivra_kvm_portable_cleanup_handoff before insert or update or delete
  on hivra_kvm_portable_private.handoff for each row
  execute function hivra_kvm_portable_private.guard_cleanup_hold();
create trigger guard_hivra_kvm_portable_cleanup_agent before update or delete
  on public.hivra_agents for each row execute function hivra_kvm_portable_private.guard_cleanup_hold();

create function hivra_kvm_portable_private.guard_runtime_rearm()
returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if new.runtime_profile is null and new.runtime_expires_at is null then return new; end if;
  if current_setting('transaction_isolation')<>'read committed'
  then raise exception 'portable KVM runtime changes require READ COMMITTED' using errcode='25001'; end if;
  if tg_op='INSERT' then
    perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  elsif exists (select 1 from hivra_kvm_portable_private.cleanup_hold
      where finished_at is null and (authority->>'ownerId'=old.owner_id or agent_id=old.agent_id))
  then raise exception 'portable KVM runtime cannot be rearmed during a handoff' using errcode='55000';
  end if;
  if exists (select 1 from hivra_kvm_portable_private.cleanup_hold
      where finished_at is null and (authority->>'ownerId'=new.owner_id or agent_id=new.agent_id))
  then raise exception 'portable KVM runtime cannot be rearmed during a handoff' using errcode='55000'; end if;
  return new;
end $$;

create trigger guard_hivra_kvm_portable_runtime_rearm before insert or update
  on hivra_kvm_portable_private.pilot_enrollment for each row
  execute function hivra_kvm_portable_private.guard_runtime_rearm();

create function hivra_kvm_portable_private.lock_cleanup_authority(
  p_action text,p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,
  p_allocation_operation_id uuid,p_binding_token_hash text,p_phase text,
  p_authoritative jsonb,p_cleanup_target jsonb
)
returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  h hivra_kvm_portable_private.handoff%rowtype;
  pins jsonb;
begin
  if p_owner_id is null or btrim(p_owner_id)='' or p_agent_id is null or p_operation_id is null
    or p_generation is null or p_allocation_operation_id is null
    or (p_binding_token_hash ~ '^[0-9a-f]{64}$') is not true
    or ((p_action='abort' and p_phase in ('checkpointing','storage_verified','restore_claimed','destination_verified'))
      or (p_action='retire' and p_phase='finished')) is not true
    or not hivra_kvm_portable_private.valid_target(p_authoritative)
    or not hivra_kvm_portable_private.valid_target(p_cleanup_target)
    or public.holder_admission_normalize_host_id(p_authoritative->>'hostId')=
       public.holder_admission_normalize_host_id(p_cleanup_target->>'hostId')
    or p_cleanup_target->>'bindingTag' is distinct from 'hivra-bind-'||left(p_binding_token_hash,32)
    or p_authoritative->>'vmid'='9302' or p_cleanup_target->>'vmid'='9302'
  then return null; end if;

  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  perform public.lock_hivra_owner_agent_slots(p_owner_id);
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_owner_id for update;
  if not found then return null; end if;
  select * into h from hivra_kvm_portable_private.handoff where retired_at is null
    and (owner_id,agent_id,operation_id,generation,phase)=(p_owner_id,p_agent_id,p_operation_id,p_generation,p_phase)
    for update;
  if not found
    or a.allocation_operation_id is distinct from p_allocation_operation_id
    or a.infrastructure_binding_token_enforced is not true
    or a.infrastructure_binding_token_hash is distinct from p_binding_token_hash
    or hivra_kvm_portable_private.agent_target(a) is distinct from p_authoritative
    or a.deployment_mode is distinct from 'hivra-managed' or a.computer_substrate is distinct from 'proxmox-kvm'
    or a.deployment_target_id is not null
    or (a.status,a.desired_state) is distinct from ('running','running')
  then return null; end if;
  perform 1 from canary_qa_writer_private.scope where singleton for share;
  if exists (select 1 from canary_qa_writer_private.scope where owner_id=p_owner_id) then return null; end if;

  if p_action='abort' then
    if (h.source,h.destination) is distinct from (p_authoritative,p_cleanup_target)
      or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation)
        is distinct from ('wake',h.operation_id,
          case when h.wake_requested_at is null then 'hibernated' else 'waking' end,h.generation)
      or a.operation_payload is distinct from '{"portable_kvm":true}'::jsonb
    then return null; end if;
  elsif (h.destination,h.source) is distinct from (p_authoritative,p_cleanup_target)
    or (a.operation_kind,a.operation_id,a.sleep_state,a.sleep_generation)
      is distinct from (null::text,null::uuid,'awake',h.generation+1)
    or nullif(a.cf_hostname,'') is null or nullif(a.cf_tunnel_id,'') is null or nullif(a.chat_url,'') is null
    or h.checkpoint_sha256 is null or h.connector_evidence->>'bootId' is null
    or h.connector_evidence->>'connectorId' is null
  then return null; end if;

  perform 1 from hivra_kvm_portable_private.pilot_enrollment
    where owner_id=p_owner_id or agent_id=p_agent_id for update;
  if exists (select 1 from hivra_kvm_portable_private.pilot_enrollment
      where (owner_id=p_owner_id or agent_id=p_agent_id)
        and (runtime_profile is not null or runtime_expires_at is not null))
  then return null; end if;

  select jsonb_object_agg(id,jsonb_build_array(env_prefix,extract(epoch from created_at))) into pins
    from (select id,env_prefix,created_at from public.proxmox_hosts
      where id in (p_authoritative->>'hostId',p_cleanup_target->>'hostId')
        and decommissioned_at is null order by id for share) as hosts;
  if pins is null or not (pins ? (p_authoritative->>'hostId') and pins ? (p_cleanup_target->>'hostId'))
    or (p_action='retire' and not hivra_kvm_portable_private.host_allowed(
      p_owner_id,p_agent_id,p_authoritative,false))
  then return null; end if;

  return jsonb_build_object('action',p_action,'ownerId',p_owner_id,'agentId',p_agent_id,
    'operationId',p_operation_id,'generation',p_generation,'allocationOperationId',p_allocation_operation_id,
    'bindingTag',p_authoritative->>'bindingTag','bindingTokenHash',p_binding_token_hash,
    'phase',p_phase,'authoritative',p_authoritative,'cleanupTarget',p_cleanup_target,'hostPins',pins,
    'checkpointSha256',h.checkpoint_sha256,'reservationSha256',h.destination_evidence->>'reservationSha256',
    'bootId',h.connector_evidence->>'bootId',
    'connectorId',h.connector_evidence->>'connectorId');
end $$;

create function hivra_kvm_portable_private.claim_cleanup(
  p_action text,p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,
  p_allocation_operation_id uuid,p_binding_token_hash text,p_phase text,
  p_authoritative jsonb,p_cleanup_target jsonb
)
returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  exact jsonb;
  held hivra_kvm_portable_private.cleanup_hold%rowtype;
begin
  exact := hivra_kvm_portable_private.lock_cleanup_authority(p_action,p_owner_id,p_agent_id,p_operation_id,
    p_generation,p_allocation_operation_id,p_binding_token_hash,p_phase,p_authoritative,p_cleanup_target);
  if exact is null then return null; end if;
  select * into held from hivra_kvm_portable_private.cleanup_hold
    where operation_id=p_operation_id;
  if not found then
    update hivra_kvm_portable_private.handoff set phase=p_phase where operation_id=p_operation_id;
    insert into hivra_kvm_portable_private.cleanup_hold(operation_id,agent_id,authority)
      values (p_operation_id,p_agent_id,exact) returning * into held;
  elsif held.finished_at is not null or held.authority is distinct from exact then
    return null;
  end if;
  return (exact-array['bindingTokenHash','hostPins'])||jsonb_build_object('receiptId',held.receipt_id);
end $$;

create function hivra_kvm_portable_private.read_cleanup(
  p_receipt_id uuid,p_action text,p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,
  p_allocation_operation_id uuid,p_binding_token_hash text,p_phase text,
  p_authoritative jsonb,p_cleanup_target jsonb
)
returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare exact jsonb;
begin
  if p_receipt_id is null then return null; end if;
  exact := hivra_kvm_portable_private.lock_cleanup_authority(p_action,p_owner_id,p_agent_id,p_operation_id,
    p_generation,p_allocation_operation_id,p_binding_token_hash,p_phase,p_authoritative,p_cleanup_target);
  if exact is null or not exists (select 1 from hivra_kvm_portable_private.cleanup_hold
      where operation_id=p_operation_id and receipt_id=p_receipt_id and finished_at is null and authority=exact)
  then return null; end if;
  return (exact-array['bindingTokenHash','hostPins'])||jsonb_build_object('receiptId',p_receipt_id);
end $$;

create function hivra_kvm_portable_private.finish_cleanup(
  p_receipt_id uuid,p_action text,p_owner_id text,p_agent_id uuid,p_operation_id uuid,p_generation bigint,
  p_allocation_operation_id uuid,p_binding_token_hash text,p_phase text,
  p_authoritative jsonb,p_cleanup_target jsonb,p_evidence jsonb
)
returns jsonb language plpgsql set search_path=pg_catalog,pg_temp as $$
declare
  held hivra_kvm_portable_private.cleanup_hold%rowtype;
  result jsonb;
begin
  if p_receipt_id is null or p_evidence is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('holder-admissions-v1',0));
  select * into held from hivra_kvm_portable_private.cleanup_hold
    where operation_id=p_operation_id and receipt_id=p_receipt_id and agent_id=p_agent_id;
  if not found then return null; end if;

  if held.finished_at is not null then
    if held.authority-array['hostPins','checkpointSha256','reservationSha256','bootId','connectorId'] is distinct from jsonb_build_object(
        'action',p_action,'ownerId',p_owner_id,'agentId',p_agent_id,'operationId',p_operation_id,
        'generation',p_generation,'allocationOperationId',p_allocation_operation_id,'phase',p_phase,
        'authoritative',p_authoritative,'cleanupTarget',p_cleanup_target,'bindingTokenHash',p_binding_token_hash,
        'bindingTag',p_authoritative->>'bindingTag')
    then return null; end if;
    return (select to_jsonb(h)-array['active_agent_id','cpu','ram_mb']
      from hivra_kvm_portable_private.handoff h where h.operation_id=p_operation_id
        and (h.owner_id,h.agent_id,h.generation)=(p_owner_id,p_agent_id,p_generation)
        and h.retired_at is not null and
          ((p_action='abort' and h.phase='aborted' and h.abort_evidence=p_evidence)
          or (p_action='retire' and h.phase='finished' and h.retirement_evidence=p_evidence)));
  end if;

  if hivra_kvm_portable_private.read_cleanup(p_receipt_id,p_action,p_owner_id,p_agent_id,p_operation_id,
      p_generation,p_allocation_operation_id,p_binding_token_hash,p_phase,p_authoritative,p_cleanup_target) is null
  then return null; end if;

  begin
    delete from hivra_kvm_portable_private.cleanup_hold
      where operation_id=p_operation_id and receipt_id=p_receipt_id and finished_at is null;
    if not found then return null; end if;
    if p_action='abort' then
      result := public.abort_hivra_kvm_portable_handoff(p_owner_id,p_agent_id,p_operation_id,p_generation,p_evidence);
    else
      result := public.finish_hivra_kvm_portable_retirement(p_owner_id,p_agent_id,p_operation_id,p_generation,p_evidence);
    end if;
    if result is null then raise sqlstate 'ZK001'; end if;
    held.finished_at := clock_timestamp();
    insert into hivra_kvm_portable_private.cleanup_hold select held.*;
  exception when sqlstate 'ZK001' then
    return null;
  end;
  return result;
end $$;

revoke all on function hivra_kvm_portable_private.guard_cleanup_hold(),
  hivra_kvm_portable_private.guard_runtime_rearm(),
  hivra_kvm_portable_private.lock_cleanup_authority(text,text,uuid,uuid,bigint,uuid,text,text,jsonb,jsonb),
  hivra_kvm_portable_private.claim_cleanup(text,text,uuid,uuid,bigint,uuid,text,text,jsonb,jsonb),
  hivra_kvm_portable_private.read_cleanup(uuid,text,text,uuid,uuid,bigint,uuid,text,text,jsonb,jsonb),
  hivra_kvm_portable_private.finish_cleanup(uuid,text,text,uuid,uuid,bigint,uuid,text,text,jsonb,jsonb,jsonb)
  from public, anon, authenticated, service_role;
