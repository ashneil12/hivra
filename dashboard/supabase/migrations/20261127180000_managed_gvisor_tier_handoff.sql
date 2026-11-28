create table public.hivra_managed_gvisor_tier_handoffs (
  computer_id uuid primary key references public.hivra_managed_gvisor_bindings(computer_id) on delete restrict,
  customer_id text not null check (btrim(customer_id) <> ''),
  operator_id text not null check (btrim(operator_id) <> '' and operator_id <> customer_id),
  generation uuid not null unique,
  phase text not null default 'checkpointing',
  source_connection_id uuid not null,
  source_target_id uuid not null,
  source_revision bigint not null check (source_revision > 0),
  source_sandbox_id uuid not null,
  source_host_identity_digest text not null check (source_host_identity_digest ~ '^[0-9a-f]{64}$'),
  destination_connection_id uuid not null check (destination_connection_id <> source_connection_id),
  destination_target_id uuid not null check (destination_target_id <> source_target_id),
  destination_active_target_id uuid generated always as (case when phase<>'retired' then destination_target_id end) stored,
  destination_revision bigint not null check (destination_revision > 0),
  destination_sandbox_id uuid not null unique check (destination_sandbox_id <> source_sandbox_id),
  destination_host_identity_digest text not null check (destination_host_identity_digest ~ '^[0-9a-f]{64}$'
    and destination_host_identity_digest <> source_host_identity_digest),
  adapter_sha256 text not null check (adapter_sha256 ~ '^[0-9a-f]{64}$'),
  runtime_sha256 text not null check (runtime_sha256 ~ '^[0-9a-f]{64}$'),
  checkpoint_receipt jsonb check (jsonb_typeof(checkpoint_receipt)='object' and octet_length(checkpoint_receipt::text)<=4096),
  health_receipt jsonb check (jsonb_typeof(health_receipt)='object' and octet_length(health_receipt::text)<=4096),
  expires_at timestamptz not null check (isfinite(expires_at)),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (expires_at > created_at and updated_at >= created_at),
  check ((phase='checkpointing' and checkpoint_receipt is null and health_receipt is null)
    or (phase='sleeping' and checkpoint_receipt is not null and health_receipt is null)
    or (phase='running' and checkpoint_receipt is not null and health_receipt is not null)
    or (phase in ('retiring','retired') and (checkpoint_receipt is not null or health_receipt is null))),
  foreign key (destination_active_target_id,destination_connection_id,operator_id)
    references public.deployment_targets(id,connection_id,user_id) on update restrict on delete restrict
);
alter table public.hivra_managed_gvisor_tier_handoffs enable row level security;
revoke all on public.hivra_managed_gvisor_tier_handoffs from public, anon, authenticated, service_role;

create function public.guard_hivra_gvisor_tier_handoff()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  guarded_computer uuid;
  handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
begin
  if tg_table_name='hivra_agents' then
    guarded_computer := old.id;
  else
    guarded_computer := old.computer_id;
  end if;
  select * into handoff from public.hivra_managed_gvisor_tier_handoffs where computer_id=guarded_computer;
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='UPDATE' and handoff.phase='retired' then
    if tg_table_name='hivra_agents' then
      if old.status='running' and (
        (old.operation_id is null and new.operation_id=handoff.generation and new.operation_kind='delete'
          and new.status='running' and new.desired_state='deleted')
        or (old.operation_id=handoff.generation and old.operation_kind='delete' and new.operation_id is null
          and new.status='deleted' and new.desired_state='deleted')
      ) then return new; end if;
    elsif old.active_target_id=handoff.source_target_id and new.lifecycle_operation_id=handoff.generation
      and new.lifecycle_action='delete'
      and (
        (old.lifecycle_operation_id is distinct from handoff.generation and new.lifecycle_receipt is null
          and new.active_target_id=old.active_target_id)
        or (old.lifecycle_operation_id=handoff.generation and old.lifecycle_action='delete'
          and old.lifecycle_receipt is null and new.active_target_id is null
          and new.lifecycle_receipt=jsonb_build_object(
            'version',1,'state','absent','computerId',handoff.computer_id,'sandboxId',handoff.source_sandbox_id))
      )
    then return new; end if;
  end if;
  raise exception 'legacy managed gVisor mutation refused for a tier handoff' using errcode='55000';
end $$;
revoke all on function public.guard_hivra_gvisor_tier_handoff() from public, anon, authenticated, service_role;

create trigger hivra_managed_gvisor_tier_agent_guard before update or delete on public.hivra_agents
  for each row when (old.computer_substrate='gvisor' and old.deployment_mode='hivra-managed')
  execute function public.guard_hivra_gvisor_tier_handoff();
create trigger hivra_managed_gvisor_tier_binding_guard before update or delete on public.hivra_managed_gvisor_bindings
  for each row execute function public.guard_hivra_gvisor_tier_handoff();

-- Enrollment is one-way. Only the trusted server may call this after checking
-- owner, entitlement, operator scope and manual pilot approval. SQL checks
-- the bound identity and current target evidence, not external host admission.
-- The generation and both placements stay pinned even after a timeout.
create function public.begin_hivra_gvisor_tier_handoff(
  p_customer text,p_computer uuid,p_operator text,
  p_source_connection uuid,p_source_target uuid,p_source_revision bigint,
  p_destination_connection uuid,p_destination_target uuid,p_destination_revision bigint,
  p_generation uuid,p_destination_sandbox uuid,p_expires_at timestamptz,p_idle_hours int default null
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
  handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
  source_host text;
  destination_host text;
  checked_at timestamptz;
  cutoff timestamptz;
begin
  if (btrim(p_customer)<>'' and btrim(p_operator)<>'' and p_customer<>p_operator
      and p_computer is not null and p_generation is not null and p_destination_sandbox is not null
      and p_source_target<>p_destination_target and p_source_connection<>p_destination_connection
      and p_source_revision>0 and p_destination_revision>0 and isfinite(p_expires_at)
      and (p_idle_hours is null or p_idle_hours between 1 and 8760)) is not true
  then return null; end if;

  perform public.lock_hivra_owner_agent_slots(p_customer);
  if p_expires_at<=clock_timestamp() then return null; end if;

  select * into handoff from public.hivra_managed_gvisor_tier_handoffs where computer_id=p_computer;
  if found then
    if (handoff.customer_id,handoff.operator_id,handoff.generation,
        handoff.source_connection_id,handoff.source_target_id,handoff.source_revision,
        handoff.destination_connection_id,handoff.destination_target_id,handoff.destination_revision,
        handoff.destination_sandbox_id)
      = (p_customer,p_operator,p_generation,p_source_connection,p_source_target,p_source_revision,
        p_destination_connection,p_destination_target,p_destination_revision,p_destination_sandbox)
      and handoff.phase in ('checkpointing','sleeping','running') and handoff.expires_at>clock_timestamp()
    then return to_jsonb(handoff) - 'destination_active_target_id'; end if;
    return null;
  end if;

  select * into agent from public.hivra_agents
    where id=p_computer and user_id=p_customer
      and deployment_mode='hivra-managed' and computer_substrate='gvisor'
      and type='linux-terminal' and computer_profile='linux-terminal'
      and status='running' and desired_state='running' and operation_id is null
      and gvisor_sandbox_id<>p_destination_sandbox for update;
  if not found then return null; end if;

  select * into binding from public.hivra_managed_gvisor_bindings
    where computer_id=p_computer and customer_id=p_customer
      and (operator_id,connection_id,target_id,connection_revision)=(p_operator,p_source_connection,p_source_target,p_source_revision)
      and active_target_id=target_id and dispatch_claim_id is not null and running_receipt is not null
      and cancelled_at is null and absence_receipt is null and cleanup_started_at is null
      and lifecycle_operation_id is distinct from p_generation
      and (lifecycle_operation_id is null or lifecycle_receipt->>'state'='running') for update;
  if not found then return null; end if;

  if exists (select 1 from public.hivra_managed_gvisor_command_activity
      where computer_id=p_computer and command_claim_id is not null)
  then return null; end if;
  if p_idle_hours is not null then
    cutoff := clock_timestamp()-make_interval(hours=>p_idle_hours);
    if not exists (select 1 from public.hivra_managed_gvisor_command_activity
        where computer_id=p_computer and last_activity_at<=cutoff)
      or exists (select 1 from public.hivra_agent_events
        where agent_id=p_computer and user_id=p_customer and event='started' and created_at>cutoff)
    then return null; end if;
  end if;

  if not public.lock_hivra_managed_gvisor_evidence(p_operator,p_source_connection,p_source_target,p_source_revision,
      agent.gvisor_adapter_sha256,agent.gvisor_runtime_sha256,false)
    or not public.lock_hivra_managed_gvisor_evidence(p_operator,p_destination_connection,p_destination_target,p_destination_revision,
      agent.gvisor_adapter_sha256,agent.gvisor_runtime_sha256)
  then return null; end if;
  select capabilities->>'hostIdentityDigest' into strict source_host from public.deployment_targets where id=p_source_target;
  select capabilities->>'hostIdentityDigest' into strict destination_host from public.deployment_targets where id=p_destination_target;
  if source_host=destination_host then return null; end if;

  checked_at := clock_timestamp();
  if p_expires_at<=checked_at then return null; end if;
  insert into public.hivra_managed_gvisor_tier_handoffs (
    computer_id,customer_id,operator_id,generation,source_connection_id,source_target_id,source_revision,
    source_sandbox_id,source_host_identity_digest,destination_connection_id,destination_target_id,destination_revision,
    destination_sandbox_id,destination_host_identity_digest,adapter_sha256,runtime_sha256,expires_at,created_at,updated_at
  ) values (
    p_computer,p_customer,p_operator,p_generation,binding.connection_id,binding.target_id,binding.connection_revision,
    agent.gvisor_sandbox_id,source_host,p_destination_connection,p_destination_target,p_destination_revision,
    p_destination_sandbox,destination_host,agent.gvisor_adapter_sha256,agent.gvisor_runtime_sha256,p_expires_at,checked_at,checked_at
  ) on conflict do nothing returning * into handoff;
  if not found then return null; end if;
  return to_jsonb(handoff) - 'destination_active_target_id';
end $$;

-- Receipt authentication and remote state verification are the server's
-- responsibility. Supply a bounded normalized receipt, never a client claim.
-- These RPCs can settle held work after expiry; they cannot authorize dispatch.
create function public.commit_hivra_gvisor_tier_checkpoint(
  p_customer text,p_computer uuid,p_generation uuid,p_receipt jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
  archive jsonb;
  metric text;
begin
  if (jsonb_typeof(p_receipt)='object' and octet_length(p_receipt::text)<=4096
      and jsonb_typeof(p_receipt->'checkpointDigest')='string'
      and p_receipt->>'checkpointDigest' ~ '^[0-9a-f]{64}$'
      and p_receipt - array['version','state','computerId','generation','connectionId','targetId',
        'revision','sandboxId','hostIdentityDigest','checkpointDigest','archive']='{}'::jsonb) is not true
  then return null; end if;
  archive := p_receipt->'archive';
  if (jsonb_typeof(archive)='object' and archive->'sha256'=p_receipt->'checkpointDigest'
      and archive - array['sha256','ciphertext_bytes','entries','bytes']='{}'::jsonb) is not true
  then return null; end if;
  foreach metric in array array['ciphertext_bytes','entries','bytes'] loop
    if (jsonb_typeof(archive->metric)='number' and archive->>metric ~ '^[0-9]{1,16}$') is not true
    then return null; end if;
    if (archive->>metric)::bigint not between
      (case when metric='ciphertext_bytes' then 1 else 0 end) and 9007199254740991
    then return null; end if;
  end loop;
  select * into handoff from public.hivra_managed_gvisor_tier_handoffs
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation for update;
  if not found or p_receipt @> jsonb_build_object(
      'version',1,'state','checkpointed','computerId',p_computer,'generation',p_generation,
      'connectionId',handoff.source_connection_id,'targetId',handoff.source_target_id,'revision',handoff.source_revision,
      'sandboxId',handoff.source_sandbox_id,'hostIdentityDigest',handoff.source_host_identity_digest
    ) is not true then return null; end if;
  if handoff.phase='sleeping' and handoff.checkpoint_receipt=p_receipt
  then return to_jsonb(handoff) - 'destination_active_target_id'; end if;
  update public.hivra_managed_gvisor_tier_handoffs set
    phase='sleeping',checkpoint_receipt=p_receipt,updated_at=greatest(updated_at,clock_timestamp())
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation and phase='checkpointing'
    returning * into handoff;
  if not found then return null; end if;
  return to_jsonb(handoff) - 'destination_active_target_id';
end $$;

create function public.commit_hivra_gvisor_tier_running(
  p_customer text,p_computer uuid,p_generation uuid,p_receipt jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
begin
  if (jsonb_typeof(p_receipt)='object' and octet_length(p_receipt::text)<=4096
      and p_receipt - array['version','state','computerId','generation','connectionId','targetId',
        'revision','sandboxId','hostIdentityDigest','checkpointDigest']='{}'::jsonb) is not true
  then return null; end if;
  select * into handoff from public.hivra_managed_gvisor_tier_handoffs
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation for update;
  if not found or handoff.checkpoint_receipt is null or p_receipt @> jsonb_build_object(
      'version',1,'state','running','computerId',p_computer,'generation',p_generation,
      'connectionId',handoff.destination_connection_id,'targetId',handoff.destination_target_id,'revision',handoff.destination_revision,
      'sandboxId',handoff.destination_sandbox_id,'hostIdentityDigest',handoff.destination_host_identity_digest,
      'checkpointDigest',handoff.checkpoint_receipt->'checkpointDigest'
    ) is not true then return null; end if;
  if handoff.phase='running' and handoff.health_receipt=p_receipt
  then return to_jsonb(handoff) - 'destination_active_target_id'; end if;
  update public.hivra_managed_gvisor_tier_handoffs set
    phase='running',health_receipt=p_receipt,updated_at=greatest(updated_at,clock_timestamp())
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation and phase='sleeping'
    returning * into handoff;
  if not found then return null; end if;
  return to_jsonb(handoff) - 'destination_active_target_id';
end $$;

create function public.read_hivra_gvisor_tier_handoff(p_customer text,p_computer uuid)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select to_jsonb(handoff) - 'destination_active_target_id' from public.hivra_managed_gvisor_tier_handoffs handoff
    where handoff.computer_id=p_computer and handoff.customer_id=p_customer and handoff.phase<>'retired';
$$;

-- Only the trusted server may retire the exact authorized QA fixture. A held
-- retirement is non-routable and is never reopened, even after a timeout.
create function public.claim_hivra_gvisor_tier_retire(
  p_customer text,p_computer uuid,p_generation uuid,p_operator text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into handoff from public.hivra_managed_gvisor_tier_handoffs
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation
      and operator_id=p_operator and phase<>'retired' for update;
  if not found then return null; end if;
  if handoff.phase<>'retiring' then
    update public.hivra_managed_gvisor_tier_handoffs
      set phase='retiring',updated_at=greatest(updated_at,clock_timestamp())
      where computer_id=p_computer and phase=handoff.phase returning * into strict handoff;
  end if;
  return to_jsonb(handoff) - 'destination_active_target_id';
end $$;

-- The server verifies absence only after installing a permanent host-side
-- fence on BOTH physical sandbox identities. Uncertain host results stay held.
create function public.commit_hivra_gvisor_tier_retire(
  p_customer text,p_computer uuid,p_generation uuid,p_operator text,p_source_receipt jsonb,p_destination_receipt jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  handoff public.hivra_managed_gvisor_tier_handoffs%rowtype;
  result jsonb;
begin
  if (octet_length(p_source_receipt::text)<=4096 and octet_length(p_destination_receipt::text)<=4096) is not true
  then return false; end if;
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into handoff from public.hivra_managed_gvisor_tier_handoffs
    where computer_id=p_computer and customer_id=p_customer and generation=p_generation
      and operator_id=p_operator and phase in ('retiring','retired') for update;
  if not found or (p_source_receipt=jsonb_build_object(
      'version',1,'state','absent','computerId',p_computer,'generation',p_generation,
      'connectionId',handoff.source_connection_id,'targetId',handoff.source_target_id,'revision',handoff.source_revision,
      'sandboxId',handoff.source_sandbox_id,'hostIdentityDigest',handoff.source_host_identity_digest
    ) and p_destination_receipt=jsonb_build_object(
      'version',1,'state','absent','computerId',p_computer,'generation',p_generation,
      'connectionId',handoff.destination_connection_id,'targetId',handoff.destination_target_id,'revision',handoff.destination_revision,
      'sandboxId',handoff.destination_sandbox_id,'hostIdentityDigest',handoff.destination_host_identity_digest
    )) is not true then return false; end if;
  if handoff.phase='retired' then return true; end if;

  -- This phase unlocks precisely the existing, generation-bound delete pair
  -- inside this transaction. Other transactions never see an open claim.
  update public.hivra_managed_gvisor_tier_handoffs
    set phase='retired',updated_at=greatest(updated_at,clock_timestamp())
    where computer_id=p_computer and phase='retiring';
  update public.hivra_managed_gvisor_bindings
    set lifecycle_operation_id=p_generation,lifecycle_action='delete',lifecycle_receipt=null
    where computer_id=p_computer and customer_id=p_customer and active_target_id=handoff.source_target_id;
  update public.hivra_agents
    set desired_state='deleted',operation_id=p_generation,operation_kind='delete',
      operation_started_at=clock_timestamp(),operation_payload='{}'::jsonb
    where id=p_computer and user_id=p_customer and status='running' and operation_id is null;
  result := public.complete_hivra_managed_gvisor_lifecycle(
    p_customer,p_computer,p_generation,'delete',
    jsonb_build_object('version',1,'state','absent','computerId',p_computer,'sandboxId',handoff.source_sandbox_id)
  );
  if (result->>'status'='deleted') is not true then
    raise exception 'managed gVisor tier retirement did not commit the delete pair' using errcode='55000';
  end if;
  return true;
end $$;

revoke all on function
  public.begin_hivra_gvisor_tier_handoff(text,uuid,text,uuid,uuid,bigint,uuid,uuid,bigint,uuid,uuid,timestamptz,int),
  public.commit_hivra_gvisor_tier_checkpoint(text,uuid,uuid,jsonb),
  public.commit_hivra_gvisor_tier_running(text,uuid,uuid,jsonb),
  public.claim_hivra_gvisor_tier_retire(text,uuid,uuid,text),
  public.commit_hivra_gvisor_tier_retire(text,uuid,uuid,text,jsonb,jsonb),
  public.read_hivra_gvisor_tier_handoff(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.begin_hivra_gvisor_tier_handoff(text,uuid,text,uuid,uuid,bigint,uuid,uuid,bigint,uuid,uuid,timestamptz,int),
  public.commit_hivra_gvisor_tier_checkpoint(text,uuid,uuid,jsonb),
  public.commit_hivra_gvisor_tier_running(text,uuid,uuid,jsonb),
  public.claim_hivra_gvisor_tier_retire(text,uuid,uuid,text),
  public.commit_hivra_gvisor_tier_retire(text,uuid,uuid,text,jsonb,jsonb),
  public.read_hivra_gvisor_tier_handoff(text,uuid)
  to service_role;

-- Avoid returning legacy authority (including a misleading settled Start) for
-- enrolled rows. The agent and binding triggers also protect other writers.
alter function public.claim_hivra_managed_gvisor_lifecycle(text,uuid,text)
  rename to claim_hivra_managed_gvisor_lifecycle_unenrolled;
revoke all on function public.claim_hivra_managed_gvisor_lifecycle_unenrolled(text,uuid,text)
  from public, anon, authenticated, service_role;
create function public.claim_hivra_managed_gvisor_lifecycle(p_customer text,p_computer uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  if exists (select 1 from public.hivra_managed_gvisor_tier_handoffs
      where computer_id=p_computer and customer_id=p_customer)
  then return jsonb_build_object('status','conflict'); end if;
  return public.claim_hivra_managed_gvisor_lifecycle_unenrolled(p_customer,p_computer,p_action);
end $$;
revoke all on function public.claim_hivra_managed_gvisor_lifecycle(text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.claim_hivra_managed_gvisor_lifecycle(text,uuid,text) to service_role;

alter function public.read_hivra_managed_gvisor_observation(text,uuid,boolean)
  rename to read_hivra_managed_gvisor_observation_unenrolled;
revoke all on function public.read_hivra_managed_gvisor_observation_unenrolled(text,uuid,boolean)
  from public, anon, authenticated, service_role;
create function public.read_hivra_managed_gvisor_observation(p_customer text,p_computer uuid,p_require_running boolean default false)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select case when not exists (select 1 from public.hivra_managed_gvisor_tier_handoffs
      where computer_id=p_computer and customer_id=p_customer)
    then public.read_hivra_managed_gvisor_observation_unenrolled(p_customer,p_computer,p_require_running) end;
$$;
revoke all on function public.read_hivra_managed_gvisor_observation(text,uuid,boolean) from public, anon, authenticated, service_role;
grant execute on function public.read_hivra_managed_gvisor_observation(text,uuid,boolean) to service_role;

create or replace function public.claim_hivra_managed_gvisor_pilot_command(
  p_customer text,p_computer uuid,p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare command_claim uuid;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  if (p_expires_at > clock_timestamp()) is not true then return null; end if;
  perform 1 from public.hivra_agents agent
    where id=p_computer and user_id=p_customer and deployment_mode='hivra-managed'
      and computer_substrate='gvisor' and type='linux-terminal' and computer_profile='linux-terminal'
      and status='running' and desired_state='running' and operation_id is null
      and not exists (select 1 from public.hivra_managed_gvisor_tier_handoffs where computer_id=agent.id)
    for update;
  if not found then return null; end if;

  insert into public.hivra_managed_gvisor_command_activity as activity(computer_id,command_claim_id)
    values(p_computer,gen_random_uuid())
    on conflict (computer_id) do update set command_claim_id=excluded.command_claim_id
      where activity.command_claim_id is null
    returning command_claim_id into command_claim;
  return command_claim;
end $$;

create or replace function public.claim_hivra_managed_gvisor_pilot_idle_stop(
  p_customer text,p_operator text,p_connection uuid,p_target uuid,p_revision bigint,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  candidate uuid;
  cutoff timestamptz;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  if (p_expires_at > clock_timestamp()) is not true or p_customer=p_operator then return null; end if;
  cutoff := clock_timestamp() - interval '10 minutes';
  select agent.id into candidate
    from public.hivra_managed_gvisor_command_activity as activity
    join public.hivra_agents as agent on agent.id=activity.computer_id
    join public.hivra_managed_gvisor_bindings as binding on binding.computer_id=agent.id and binding.customer_id=agent.user_id
    where agent.user_id=p_customer and agent.deployment_mode='hivra-managed'
      and agent.computer_substrate='gvisor' and agent.type='linux-terminal' and agent.computer_profile='linux-terminal'
      and agent.status='running' and agent.desired_state='running' and agent.operation_id is null
      and binding.operator_id=p_operator and binding.connection_id=p_connection
      and binding.active_target_id=p_target and binding.target_id=p_target and binding.connection_revision=p_revision
      and activity.last_activity_at<=cutoff and activity.command_claim_id is null
      and not exists(select 1 from public.hivra_managed_gvisor_tier_handoffs where computer_id=agent.id)
      and not exists(select 1 from public.hivra_agent_events as event
        where event.agent_id=agent.id and event.user_id=p_customer and event.event='started' and event.created_at>cutoff)
    order by activity.last_activity_at, agent.id limit 1 for update of agent;
  if not found then return null; end if;
  return public.claim_hivra_managed_gvisor_lifecycle(p_customer,candidate,'stop');
end $$;
