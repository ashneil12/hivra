-- Managed sandbox reservation and lifecycle. Launch is default-off in the server.
create table public.hivra_managed_gvisor_bindings (
  computer_id uuid primary key references public.hivra_agents(id)
    on delete restrict deferrable initially deferred,
  customer_id text not null,
  operator_id text not null,
  connection_id uuid not null,
  target_id uuid not null,
  active_target_id uuid,
  connection_revision bigint not null check (connection_revision > 0),
  provision_operation_id uuid not null,
  cancelled_at timestamptz,
  dispatch_claim_id uuid,
  absence_receipt jsonb,
  running_receipt jsonb,
  cleanup_started_at timestamptz,
  lifecycle_operation_id uuid,
  lifecycle_action text,
  lifecycle_receipt jsonb,
  check (((lifecycle_operation_id is null and lifecycle_action is null and lifecycle_receipt is null)
    or (lifecycle_operation_id is not null and lifecycle_action in ('start','stop','delete'))) is true),
  check (customer_id <> operator_id),
  check (((cancelled_at is null and absence_receipt is null and active_target_id=target_id)
    or (cancelled_at is not null and dispatch_claim_id is null and absence_receipt is null and active_target_id is null)
    or (cancelled_at is null and dispatch_claim_id is not null and absence_receipt is not null and active_target_id is null)) is true),
  foreign key (active_target_id, connection_id, operator_id)
    references public.deployment_targets(id, connection_id, user_id)
    on update restrict on delete restrict
);
alter table public.hivra_managed_gvisor_bindings enable row level security;
revoke all on public.hivra_managed_gvisor_bindings from public, anon, authenticated, service_role;
grant select on public.hivra_managed_gvisor_bindings to service_role;

-- Extend the current substrate matrix without restating older branches.
do $$
declare current_check text;
begin
  select pg_get_expr(conbin, conrelid) into strict current_check
    from pg_constraint where conrelid='public.hivra_agents'::regclass
      and conname='hivra_agents_provider_identity_check';
  alter table public.hivra_agents drop constraint hivra_agents_provider_identity_check;
  execute format($check$
    alter table public.hivra_agents add constraint hivra_agents_provider_identity_check
    check ((%s) or ((
      computer_substrate='gvisor' and deployment_mode='hivra-managed'
      and proxmox_host='__hivra_managed_gvisor_no_ambient_authority__'
      and vmid is null and provider_capacity_order_id is null
      and provider_enrollment_attempt_id is null and provider_server_id is null
      and infrastructure_connection_id is null and deployment_target_id is null
      and infrastructure_connection_revision is null
      and gvisor_sandbox_id is not null and gvisor_launch_request_id is not null
      and gvisor_adapter_version='2026.10.20.1'
      and gvisor_adapter_sha256 ~ '^[0-9a-f]{64}$' and gvisor_runtime_sha256 ~ '^[0-9a-f]{64}$'
      and computer_profile='linux-terminal' and type='linux-terminal'
      and cpu_max=cpu and ram_max=ram and infrastructure_binding_token_enforced is true
      and ((status='provisioning' and desired_state='running' and operation_kind='provision' and operation_id is not null)
        or (status in ('running','stopped') and (
          (operation_id is null and desired_state=status)
          or (operation_id is not null and (
            (operation_kind='start' and status='stopped' and desired_state='running')
            or (operation_kind='stop' and status='running' and desired_state='stopped')
            or (operation_kind='delete' and desired_state='deleted')))))
        or (status='deleted' and desired_state='deleted' and operation_id is null))
      and gvisor_observation is null and gvisor_cleanup_receipt is null
    ) is true))
  $check$, current_check);
end $$;

-- Keep the original observation/absence contract for self-managed rows. The
-- undispatched managed cancellation proof lives in the private binding table.
do $$
declare current_check text;
begin
  select pg_get_expr(conbin, conrelid) into strict current_check
    from pg_constraint where conrelid='public.hivra_agents'::regclass
      and conname='hivra_agents_gvisor_observation_check';
  alter table public.hivra_agents drop constraint hivra_agents_gvisor_observation_check;
  execute format($check$
    alter table public.hivra_agents add constraint hivra_agents_gvisor_observation_check
    check ((%s) or ((computer_substrate='gvisor' and deployment_mode='hivra-managed'
      and status='deleted' and gvisor_observation is null and gvisor_cleanup_receipt is null) is true))
  $check$, current_check);
end $$;

create function public.guard_hivra_managed_gvisor_reservation()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if tg_op='INSERT' then
    perform 1 from public.hivra_managed_gvisor_bindings b
      where b.computer_id=new.id and b.customer_id=new.user_id and b.cancelled_at is null
        and b.provision_operation_id=new.operation_id and new.status='provisioning';
    if not found then
      raise exception 'managed gVisor reservation requires its exact customer binding and operation' using errcode='23514';
    end if;
    return new;
  end if;
  if tg_op='UPDATE' then
    if old.status in ('running','stopped')
      and (to_jsonb(new) - array['status','desired_state','operation_id','operation_kind','operation_started_at','operation_payload'])
        = (to_jsonb(old) - array['status','desired_state','operation_id','operation_kind','operation_started_at','operation_payload'])
      and exists (select 1 from public.hivra_managed_gvisor_bindings b
        where b.computer_id=old.id and b.customer_id=old.user_id and b.running_receipt is not null
          and (
            (old.operation_id is null and new.status=old.status and new.operation_id=b.lifecycle_operation_id
              and new.operation_kind=b.lifecycle_action and b.lifecycle_receipt is null)
            or (old.operation_id=b.lifecycle_operation_id and old.operation_kind=b.lifecycle_action
              and new.operation_id is null and b.lifecycle_receipt is not null
              and new.status=case b.lifecycle_receipt->>'state' when 'absent' then 'deleted' else b.lifecycle_receipt->>'state' end)
          ))
    then return new; end if;
    if old.status='provisioning' and old.operation_kind='provision'
      and new.status='running' and new.operation_id is null
      and (to_jsonb(new) - array['status','operation_id','operation_kind','operation_started_at','operation_payload','provisioned_at'])
        = (to_jsonb(old) - array['status','operation_id','operation_kind','operation_started_at','operation_payload','provisioned_at'])
      and exists (select 1 from public.hivra_managed_gvisor_bindings b where b.computer_id=old.id
        and b.customer_id=old.user_id and b.provision_operation_id=old.operation_id and b.running_receipt is not null)
    then return new; end if;
    if old.status='provisioning' and old.operation_kind='provision'
      and new.status='deleted' and new.desired_state='deleted'
      and new.operation_id is null and new.operation_kind is null
      and new.operation_started_at is null and new.operation_payload is null
      and (to_jsonb(new) - array['status','desired_state','operation_id','operation_kind',
          'operation_started_at','operation_payload'])
        = (to_jsonb(old) - array['status','desired_state','operation_id','operation_kind',
          'operation_started_at','operation_payload'])
      and exists (select 1 from public.hivra_managed_gvisor_bindings b where b.computer_id=old.id
        and b.customer_id=old.user_id and b.provision_operation_id=old.operation_id and (b.cancelled_at is not null or b.absence_receipt is not null))
    then return new; end if;
  end if;
  raise exception 'managed gVisor reservation is immutable pending lifecycle support' using errcode='55000';
end $$;

-- The existing guard still handles every previous case. An update into or
-- out of the managed lane is independently refused before any remote work.
drop trigger hivra_gvisor_computer_guard on public.hivra_agents;
create trigger hivra_gvisor_computer_insert_guard before insert on public.hivra_agents
  for each row when ((new.computer_substrate='gvisor' and new.deployment_mode='hivra-managed') is not true)
  execute function public.guard_hivra_gvisor_computer();
create trigger hivra_gvisor_computer_update_guard before update on public.hivra_agents
  for each row when ((old.computer_substrate='gvisor' and old.deployment_mode='hivra-managed') is not true
    and (new.computer_substrate='gvisor' and new.deployment_mode='hivra-managed') is not true)
  execute function public.guard_hivra_gvisor_computer();
create trigger hivra_gvisor_computer_delete_guard before delete on public.hivra_agents
  for each row when ((old.computer_substrate='gvisor' and old.deployment_mode='hivra-managed') is not true)
  execute function public.guard_hivra_gvisor_computer();
create trigger hivra_managed_gvisor_insert_guard before insert on public.hivra_agents
  for each row when (new.computer_substrate='gvisor' and new.deployment_mode='hivra-managed')
  execute function public.guard_hivra_managed_gvisor_reservation();
create trigger hivra_managed_gvisor_update_guard before update on public.hivra_agents
  for each row when ((old.computer_substrate='gvisor' and old.deployment_mode='hivra-managed')
    or (new.computer_substrate='gvisor' and new.deployment_mode='hivra-managed'))
  execute function public.guard_hivra_managed_gvisor_reservation();
create trigger hivra_managed_gvisor_delete_guard before delete on public.hivra_agents
  for each row when (old.computer_substrate='gvisor' and old.deployment_mode='hivra-managed')
  execute function public.guard_hivra_managed_gvisor_reservation();
create function public.guard_hivra_managed_gvisor_binding()
returns trigger language plpgsql set search_path=pg_catalog,pg_temp as $$
begin
  if tg_op='UPDATE' then
    if old.active_target_id is not null and old.running_receipt is not null
      and (to_jsonb(new) - array['lifecycle_operation_id','lifecycle_action','lifecycle_receipt','active_target_id','absence_receipt'])
        = (to_jsonb(old) - array['lifecycle_operation_id','lifecycle_action','lifecycle_receipt','active_target_id','absence_receipt'])
      and (
        ((old.lifecycle_operation_id is null or old.lifecycle_receipt is not null)
          and new.lifecycle_operation_id is not null and new.lifecycle_operation_id is distinct from old.lifecycle_operation_id
          and new.lifecycle_receipt is null and new.active_target_id=old.active_target_id and new.absence_receipt is null)
        or (old.lifecycle_operation_id is not null and old.lifecycle_receipt is null and new.lifecycle_receipt is not null
          and new.lifecycle_operation_id=old.lifecycle_operation_id and new.lifecycle_action=old.lifecycle_action
          and ((old.lifecycle_action='delete' and new.active_target_id is null and new.absence_receipt=new.lifecycle_receipt)
            or (old.lifecycle_action in ('start','stop') and new.active_target_id=old.active_target_id and new.absence_receipt is null)))
      )
    then return new; end if;
    if old.active_target_id is not null and old.running_receipt is null
      and (to_jsonb(new) - array['cancelled_at','dispatch_claim_id','absence_receipt','active_target_id','running_receipt','cleanup_started_at'])
        = (to_jsonb(old) - array['cancelled_at','dispatch_claim_id','absence_receipt','active_target_id','running_receipt','cleanup_started_at'])
      and (
        (old.dispatch_claim_id is null and new.dispatch_claim_id is not null
          and new.active_target_id=old.active_target_id and new.cancelled_at is null and new.absence_receipt is null
          and new.running_receipt is null and new.cleanup_started_at is null)
        or (old.dispatch_claim_id is not null and new.dispatch_claim_id=old.dispatch_claim_id
          and new.active_target_id=old.active_target_id and new.cancelled_at is null and new.absence_receipt is null
          and old.cleanup_started_at is null
          and ((new.running_receipt is not null and new.cleanup_started_at is null)
            or (new.running_receipt is null and new.cleanup_started_at is not null)))
        or (new.active_target_id is null and new.running_receipt is null
          and new.cleanup_started_at is not distinct from old.cleanup_started_at and new.dispatch_claim_id is not distinct from old.dispatch_claim_id
          and ((old.dispatch_claim_id is null and new.cancelled_at is not null and new.absence_receipt is null)
            or (old.dispatch_claim_id is not null and old.cleanup_started_at is not null
              and new.cancelled_at is null and new.absence_receipt is not null)))
      )
    then return new; end if;
  end if;
  raise exception 'managed gVisor binding is immutable' using errcode='55000';
end $$;
create trigger hivra_managed_gvisor_binding_immutable
  before update or delete on public.hivra_managed_gvisor_bindings
  for each row execute function public.guard_hivra_managed_gvisor_binding();

-- A binding insert or cancellation cannot commit independently of its agent.
create function public.check_hivra_managed_gvisor_binding_pair()
returns trigger language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform 1 from public.hivra_managed_gvisor_bindings b join public.hivra_agents a
    on (a.id,a.user_id)=(b.computer_id,b.customer_id)
    where b.computer_id=new.computer_id and a.computer_substrate='gvisor' and a.deployment_mode='hivra-managed'
      and ((b.active_target_id is not null and b.running_receipt is null and a.status='provisioning' and a.operation_id=b.provision_operation_id)
        or (b.active_target_id is not null and b.running_receipt is not null and a.status in ('running','stopped')
          and ((a.operation_id is null and (b.lifecycle_operation_id is null or b.lifecycle_receipt is not null))
            or (a.operation_id=b.lifecycle_operation_id and a.operation_kind=b.lifecycle_action and b.lifecycle_receipt is null)))
        or (b.active_target_id is null and a.status='deleted' and a.operation_id is null
          and (b.absence_receipt is null or b.absence_receipt @> jsonb_build_object(
            'version',1,'state','absent','computerId',a.id,'sandboxId',a.gvisor_sandbox_id))));
  if not found then
    raise exception 'managed gVisor binding and agent did not commit together' using errcode='23514';
  end if;
  return null;
end $$;
create constraint trigger hivra_managed_gvisor_binding_pair
  after insert or update on public.hivra_managed_gvisor_bindings deferrable initially deferred
  for each row execute function public.check_hivra_managed_gvisor_binding_pair();
revoke all on function public.check_hivra_managed_gvisor_binding_pair() from public, anon, authenticated, service_role;

-- Both reservation and dispatch pin the same current evidence under row locks.
create function public.lock_hivra_managed_gvisor_evidence(
  p_operator text,p_connection uuid,p_target uuid,p_revision bigint,p_adapter_sha text,p_runtime_sha text,
  p_require_fresh boolean default true
) returns boolean language plpgsql set search_path=pg_catalog,pg_temp as $$
declare evidence_at timestamptz; checked_at timestamptz;
begin
  select t.last_preflight_at into evidence_at
    from public.infrastructure_connections c join public.deployment_targets t
      on (t.connection_id,t.user_id)=(c.id,c.user_id)
    where (c.id,c.user_id,c.revision)=(p_connection,p_operator,p_revision)
      and c.provider='host' and c.status='ready'
      and t.id=p_target and t.evidence_connection_revision=p_revision and t.status='ready'
      and t.external_id ~ '^gvisor-[0-9a-f]{24}$'
      and t.isolation_class='application-kernel' and t.supported_isolation_drivers=array['gvisor-runsc']::text[]
      and t.capabilities @> '{
        "kind":"gvisor","launchReady":true,"adapter":{"version":"2026.10.20.1"},"runtime":{"path":"/usr/local/bin/runsc"},
        "runtimeCompatibility":{"contractVersion":1,"supportedWorkloadKinds":["linux-terminal"]},
        "resourcePolicy":{"reservationEqualsMaximum":true,"aggregateAdmission":"serialized-host-headroom-v1"},
        "access":{"terminal":"owner-gated-command-v1","publicPorts":false},"desktop":false,"windows":false
      }'::jsonb
      and t.capabilities#>'{runtimeCompatibility,supportedWorkloadKinds}'='["linux-terminal"]'::jsonb
      and t.capabilities->>'hostIdentityDigest' ~ '^[0-9a-f]{64}$'
      and t.capabilities#>>'{adapter,sha256}'=p_adapter_sha and t.capabilities#>>'{runtime,sha256}'=p_runtime_sha
    for share of c,t;
  checked_at := clock_timestamp();
  return found and (not p_require_fresh or coalesce(evidence_at between checked_at-interval '15 minutes' and checked_at,false));
end $$;
revoke all on function public.lock_hivra_managed_gvisor_evidence(text,uuid,uuid,bigint,text,text,boolean)
  from public, anon, authenticated, service_role;

-- The trusted server supplies the authenticated and entitled customer, their
-- plan limit, and the exact operator tuple from validated server config.
-- Recheck evidence inside the transaction under locks, including the digests
-- observed by the server. No credentials, host calls, or dispatch occur here.
create function public.reserve_hivra_managed_gvisor(
  p_customer text, p_request uuid, p_name text, p_cpu numeric, p_ram integer,
  p_agent_limit integer, p_operator text, p_connection uuid, p_target uuid, p_revision bigint,
  p_adapter_sha text, p_runtime_sha text,
  p_cpu_budget numeric,p_ram_budget_mb bigint,p_max_cpu numeric,p_max_ram_mb bigint
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  existing public.hivra_agents%rowtype;
  computer uuid := gen_random_uuid();
  sandbox uuid := gen_random_uuid();
  operation uuid := gen_random_uuid();
  checked_at timestamptz;
  used_cpu numeric;
  used_ram_mb numeric;
begin
  if (length(btrim(p_customer)) between 1 and 256 and length(btrim(p_operator)) between 1 and 256
    and p_customer<>p_operator and p_request is not null
    and length(p_name) between 1 and 60 and p_name=btrim(p_name)
    and p_cpu between 0.5 and 32 and mod(p_cpu*2,1)=0 and p_ram between 1 and 128
    and p_agent_limit between 0 and 100000 and p_connection is not null
    and p_target is not null and p_revision>0
    and p_adapter_sha ~ '^[0-9a-f]{64}$' and p_runtime_sha ~ '^[0-9a-f]{64}$'
    and p_cpu_budget between 0 and 1000000 and p_ram_budget_mb between 0 and 1000000000
    and p_max_cpu between 0 and 1000000 and p_max_ram_mb between 0 and 1000000000) is not true
  then return jsonb_build_object('status','invalid_request'); end if;

  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into existing from public.hivra_agents
    where user_id=p_customer and gvisor_launch_request_id=p_request;
  if found then
    if (existing.computer_substrate='gvisor' and existing.deployment_mode='hivra-managed'
      and existing.name=p_name and existing.cpu=p_cpu and existing.ram=p_ram
      and existing.gvisor_adapter_sha256=p_adapter_sha and existing.gvisor_runtime_sha256=p_runtime_sha
      and exists(select 1 from public.hivra_managed_gvisor_bindings b
        where b.computer_id=existing.id and b.customer_id=p_customer and b.operator_id=p_operator
          and b.connection_id=p_connection and b.target_id=p_target and b.connection_revision=p_revision)) is not true
    then return jsonb_build_object('status','conflict'); end if;
    return jsonb_build_object('status',case when existing.status='deleted' then 'cancelled' when existing.status in ('running','stopped') then 'ready' else 'replay' end,
      'computerId',existing.id,'operationId',existing.operation_id);
  end if;

  if public.hivra_owner_agent_slot_count(p_customer)>=p_agent_limit then
    return jsonb_build_object('status','plan_agent_limit');
  end if;
  -- Same pool accounting as resource-gate.ts. Check under the existing
  -- customer slot lock so simultaneous managed sandbox reservations cannot
  -- spend the same CPU/RAM. A held or stopped sandbox still counts.
  select coalesce(sum(cpu),0),coalesce(sum(ram_mb),0) into used_cpu,used_ram_mb
    from (
      select a.cpu,a.ram::numeric*1024 as ram_mb from public.hivra_agents a
        where a.user_id=p_customer and a.deployment_mode='hivra-managed'
          and a.status in ('provisioning','running','stopped') and a.type<>'aeon'
      union all
      select h.cpu_limit,h.ram_limit from public.hermes_instances h
        where h.user_id=p_customer and h.status in ('provisioning','running','stopped')
          and h.lifecycle_state not in ('deleted','cold_archived','pending_deletion')
    ) usage;
  if p_cpu>p_max_cpu or p_ram*1024>p_max_ram_mb
    or used_cpu+p_cpu>p_cpu_budget or used_ram_mb+p_ram*1024>p_ram_budget_mb
  then return jsonb_build_object('status','plan_compute_limit'); end if;
  if not public.lock_hivra_managed_gvisor_evidence(p_operator,p_connection,p_target,p_revision,p_adapter_sha,p_runtime_sha) then
    return jsonb_build_object('status','authority_changed');
  end if;
  checked_at := clock_timestamp();

  -- Insert the binding first so the agent guard can check it. The deferred FK
  -- requires the paired agent before commit. Any later failure rolls back both.
  insert into public.hivra_managed_gvisor_bindings
    (computer_id,customer_id,operator_id,connection_id,target_id,active_target_id,connection_revision,provision_operation_id)
    values (computer,p_customer,p_operator,p_connection,p_target,p_target,p_revision,operation);
  perform set_config('hivra.agent_slot_checked','on',true);
  insert into public.hivra_agents
    (id,user_id,type,computer_profile,name,status,desired_state,deployment_mode,computer_substrate,proxmox_host,
     cpu,ram,cpu_max,ram_max,gvisor_sandbox_id,gvisor_adapter_version,gvisor_adapter_sha256,gvisor_runtime_sha256,
     infrastructure_binding_token_hash,infrastructure_binding_token_enforced,gvisor_launch_request_id,
     operation_id,operation_kind,operation_started_at,operation_payload)
    values (computer,p_customer,'linux-terminal','linux-terminal',p_name,'provisioning','running','hivra-managed',
      'gvisor','__hivra_managed_gvisor_no_ambient_authority__',p_cpu,p_ram,p_cpu,p_ram,sandbox,'2026.10.20.1',p_adapter_sha,p_runtime_sha,
      encode(sha256(convert_to('hivra-gvisor-owner-v1','UTF8') || decode('00','hex') || convert_to(p_customer,'UTF8')),'hex'),
      true,p_request,operation,'provision',checked_at,jsonb_build_object('sandboxId',sandbox,'cpu',p_cpu,'ram',p_ram));
  perform set_config('hivra.agent_slot_checked','off',true);
  return jsonb_build_object('status','reserved','computerId',computer,'operationId',operation);
end $$;
-- Cancellation shares the customer's slot lock and the agent/binding row
-- locks with claim. A lost claim response never restores cancellation rights.
create function public.cancel_undispatched_hivra_managed_gvisor(p_customer text,p_computer uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents
    where id=p_computer and user_id=p_customer and deployment_mode='hivra-managed'
      and computer_substrate='gvisor' for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into binding from public.hivra_managed_gvisor_bindings
    where computer_id=p_computer and customer_id=p_customer for update;
  if not found then return jsonb_build_object('status','unconfirmed'); end if;
  if agent.status='deleted' and binding.cancelled_at is not null then
    return jsonb_build_object('status','cancelled','agent',to_jsonb(agent));
  end if;
  if (agent.status='provisioning' and agent.operation_kind='provision'
    and agent.operation_id=binding.provision_operation_id and binding.cancelled_at is null
    and binding.dispatch_claim_id is null
    and binding.active_target_id=binding.target_id) is not true
  then return jsonb_build_object('status','unconfirmed'); end if;

  update public.hivra_managed_gvisor_bindings set cancelled_at=clock_timestamp(),active_target_id=null
    where computer_id=p_computer and customer_id=p_customer;
  update public.hivra_agents set status='deleted',desired_state='deleted',
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=p_computer and user_id=p_customer and operation_id=binding.provision_operation_id
    returning * into strict agent;
  return jsonb_build_object('status','cancelled','agent',to_jsonb(agent));
end $$;
revoke all on function public.cancel_undispatched_hivra_managed_gvisor(text,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_undispatched_hivra_managed_gvisor(text,uuid) to service_role;
revoke all on function public.guard_hivra_managed_gvisor_binding() from public, anon, authenticated, service_role;
revoke all on function public.guard_hivra_managed_gvisor_reservation() from public, anon, authenticated, service_role;
revoke all on function public.reserve_hivra_managed_gvisor(text,uuid,text,numeric,integer,integer,text,uuid,uuid,bigint,text,text,numeric,bigint,numeric,bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_hivra_managed_gvisor(text,uuid,text,numeric,integer,integer,text,uuid,uuid,bigint,text,text,numeric,bigint,numeric,bigint)
  to service_role;

-- Only the caller that transitions the reservation gets the token and
-- authority. A repeated or lost response never grants another dispatch.
create function public.claim_hivra_managed_gvisor_dispatch(p_customer text,p_computer uuid,p_operation uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
  claim uuid := gen_random_uuid();
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents where id=p_computer and user_id=p_customer
    and computer_substrate='gvisor' and deployment_mode='hivra-managed' for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into binding from public.hivra_managed_gvisor_bindings
    where computer_id=p_computer and customer_id=p_customer for update;
  if (agent.status='provisioning' and agent.desired_state='running' and agent.operation_kind='provision'
    and agent.operation_id=p_operation and binding.provision_operation_id=p_operation
    and binding.active_target_id=binding.target_id) is not true
  then return jsonb_build_object('status','conflict'); end if;
  if binding.dispatch_claim_id is not null then return jsonb_build_object('status','held'); end if;
  if not public.lock_hivra_managed_gvisor_evidence(binding.operator_id,binding.connection_id,binding.target_id,
      binding.connection_revision,agent.gvisor_adapter_sha256,agent.gvisor_runtime_sha256)
  then return jsonb_build_object('status','authority_changed'); end if;
  update public.hivra_managed_gvisor_bindings set dispatch_claim_id=claim where computer_id=p_computer;
  return jsonb_build_object('status','claimed','claimId',claim,'customerId',p_customer,'computerId',p_computer,
    'operationId',p_operation,'operatorId',binding.operator_id,'connectionId',binding.connection_id,
    'targetId',binding.target_id,'revision',binding.connection_revision,'sandboxId',agent.gvisor_sandbox_id,
    'adapterSha',agent.gvisor_adapter_sha256,'runtimeSha',agent.gvisor_runtime_sha256,'cpu',agent.cpu,'ram',agent.ram);
end $$;
revoke all on function public.claim_hivra_managed_gvisor_dispatch(text,uuid,uuid) from public, anon, authenticated, service_role;
grant execute on function public.claim_hivra_managed_gvisor_dispatch(text,uuid,uuid) to service_role;

-- The trusted server supplies a receipt observed from the bound adapter after
-- a confirmed deletion. Cancellation or a transport timeout cannot call this
-- transition. No host/authority fields come from a customer request.
create function public.release_hivra_managed_gvisor_absent(
  p_customer text,p_computer uuid,p_operation uuid,p_claim uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents where id=p_computer and user_id=p_customer
    and computer_substrate='gvisor' and deployment_mode='hivra-managed' for update;
  if not found then return false; end if;
  select * into binding from public.hivra_managed_gvisor_bindings
    where computer_id=p_computer and customer_id=p_customer for update;
  if (binding.dispatch_claim_id=p_claim and binding.provision_operation_id=p_operation
    and binding.cleanup_started_at is not null and p_receipt=jsonb_build_object('version',1,'state','absent','computerId',p_computer,'sandboxId',agent.gvisor_sandbox_id)) is not true
  then return false; end if;
  if agent.status='deleted' and binding.absence_receipt=p_receipt then return true; end if;
  if (agent.status='provisioning' and agent.operation_kind='provision' and agent.operation_id=p_operation
    and binding.active_target_id=binding.target_id) is not true then return false; end if;
  update public.hivra_managed_gvisor_bindings set absence_receipt=p_receipt,active_target_id=null where computer_id=p_computer;
  update public.hivra_agents set status='deleted',desired_state='deleted',operation_id=null,
    operation_kind=null,operation_started_at=null,operation_payload=null where id=p_computer;
  return true;
end $$;
revoke all on function public.release_hivra_managed_gvisor_absent(text,uuid,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.release_hivra_managed_gvisor_absent(text,uuid,uuid,uuid,jsonb) to service_role;

-- Read authority for status/reconciliation only. This does not grant dispatch.
create function public.read_hivra_managed_gvisor_observation(p_customer text,p_computer uuid,p_require_running boolean default false)
returns jsonb language sql stable security definer set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('status','observe','claimId',b.dispatch_claim_id,'customerId',a.user_id,
    'computerId',a.id,'operationId',b.provision_operation_id,'operatorId',b.operator_id,
    'connectionId',b.connection_id,'targetId',b.target_id,'revision',b.connection_revision,
    'sandboxId',a.gvisor_sandbox_id,'adapterSha',a.gvisor_adapter_sha256,'runtimeSha',a.gvisor_runtime_sha256,
    'cpu',a.cpu,'ram',a.ram)
  from public.hivra_agents a join public.hivra_managed_gvisor_bindings b on (b.computer_id,b.customer_id)=(a.id,a.user_id)
  where a.id=p_computer and a.user_id=p_customer and a.deployment_mode='hivra-managed' and a.computer_substrate='gvisor'
    and a.status in ('provisioning','running','stopped') and b.active_target_id=b.target_id
    and b.dispatch_claim_id is not null and b.cleanup_started_at is null
    and (p_require_running is false or (a.status='running' and a.operation_id is null and b.running_receipt is not null));
$$;

-- Close the race between an observation of running and the provision worker
-- starting its cleanup. Only the winner can advance its side of the operation.
create function public.begin_hivra_managed_gvisor_cleanup(p_customer text,p_computer uuid,p_operation uuid,p_claim uuid)
returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  perform 1 from public.hivra_agents where id=p_computer and user_id=p_customer
    and status='provisioning' and operation_kind='provision' and operation_id=p_operation for update;
  if not found then return false; end if;
  update public.hivra_managed_gvisor_bindings set cleanup_started_at=clock_timestamp()
    where computer_id=p_computer and customer_id=p_customer and provision_operation_id=p_operation
      and active_target_id=target_id and dispatch_claim_id=p_claim and cleanup_started_at is null and running_receipt is null;
  return found;
end $$;

create function public.complete_hivra_managed_gvisor_ready(
  p_customer text,p_computer uuid,p_operation uuid,p_claim uuid,p_receipt jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents where id=p_computer and user_id=p_customer
    and computer_substrate='gvisor' and deployment_mode='hivra-managed' for update;
  if not found then return false; end if;
  select * into binding from public.hivra_managed_gvisor_bindings where computer_id=p_computer and customer_id=p_customer for update;
  if (binding.provision_operation_id=p_operation and binding.dispatch_claim_id=p_claim
    and binding.active_target_id=binding.target_id and binding.cleanup_started_at is null
    and p_receipt @> jsonb_build_object('version',1,'state','running','computerId',p_computer,
      'sandboxId',agent.gvisor_sandbox_id,'cpu',agent.cpu,'memoryMb',agent.ram*1024,
      'adapterVersion',agent.gvisor_adapter_version,'isolationClass','application-kernel','isolationDriver','gvisor-runsc',
      'outerHostBoundary','operator-owned-host','runtime','runsc','reservationEqualsMaximum',true)
    and p_receipt->'publicPorts'='[]'::jsonb
    and p_receipt->>'image'='python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285'
    and p_receipt->>'workspace'='hivra-gvisor-workspace-' || agent.gvisor_sandbox_id::text
    and p_receipt->>'network'='hivra-gvisor-net-' || agent.gvisor_sandbox_id::text) is not true
  then return false; end if;
  if agent.status='running' then return coalesce(binding.running_receipt=p_receipt,false); end if;
  if (agent.status='provisioning' and agent.operation_kind='provision' and agent.operation_id=p_operation
    and binding.running_receipt is null) is not true then return false; end if;
  update public.hivra_managed_gvisor_bindings set running_receipt=p_receipt where computer_id=p_computer;
  update public.hivra_agents set status='running',provisioned_at=clock_timestamp(),operation_id=null,
    operation_kind=null,operation_started_at=null,operation_payload=null where id=p_computer;
  return true;
end $$;
revoke all on function public.read_hivra_managed_gvisor_observation(text,uuid,boolean),
  public.begin_hivra_managed_gvisor_cleanup(text,uuid,uuid,uuid),
  public.complete_hivra_managed_gvisor_ready(text,uuid,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.read_hivra_managed_gvisor_observation(text,uuid,boolean),
  public.begin_hivra_managed_gvisor_cleanup(text,uuid,uuid,uuid),
  public.complete_hivra_managed_gvisor_ready(text,uuid,uuid,uuid,jsonb) to service_role;

-- Persist intent and hand out exactly one mutation authorization. A repeat of
-- a held delete can observe only. Sleep/wake stay held after a missing reply:
-- a status sample cannot exclude a delayed power command.
create function public.claim_hivra_managed_gvisor_lifecycle(p_customer text,p_computer uuid,p_action text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
  op uuid;
  outcome text;
  desired text;
begin
  if coalesce(p_action,'') not in ('start','stop','delete') then return jsonb_build_object('status','conflict'); end if;
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents where id=p_computer and user_id=p_customer
    and computer_substrate='gvisor' and deployment_mode='hivra-managed' for update;
  if not found then return jsonb_build_object('status','not_found'); end if;
  select * into binding from public.hivra_managed_gvisor_bindings where computer_id=p_computer and customer_id=p_customer for update;
  if p_action='delete' and agent.status='deleted'
    and (binding.cancelled_at is not null or binding.absence_receipt is not null) then
    return jsonb_build_object('status','settled','agent',to_jsonb(agent));
  end if;
  if binding.running_receipt is null then return jsonb_build_object('status','conflict'); end if;
  desired := case p_action when 'start' then 'running' when 'stop' then 'stopped' else 'deleted' end;
  if agent.operation_id is null and agent.status=desired then
    return jsonb_build_object('status','settled','agent',to_jsonb(agent));
  end if;
  if agent.status not in ('running','stopped') or binding.active_target_id is distinct from binding.target_id
  then return jsonb_build_object('status','conflict'); end if;
  if agent.operation_id is not null and (p_action<>'delete' or agent.operation_kind<>'delete'
    or agent.operation_id is distinct from binding.lifecycle_operation_id)
  then return jsonb_build_object('status','held'); end if;
  if not public.lock_hivra_managed_gvisor_evidence(binding.operator_id,binding.connection_id,binding.target_id,
    binding.connection_revision,agent.gvisor_adapter_sha256,agent.gvisor_runtime_sha256,false)
  then return jsonb_build_object('status','authority_changed'); end if;

  if agent.operation_id is not null then
    op := agent.operation_id;
    outcome := 'observe';
  else
    op := gen_random_uuid();
    outcome := 'claimed';
    update public.hivra_managed_gvisor_bindings set lifecycle_operation_id=op,lifecycle_action=p_action,lifecycle_receipt=null
      where computer_id=p_computer;
    update public.hivra_agents set operation_id=op,operation_kind=p_action,
      operation_started_at=clock_timestamp(),operation_payload='{}'::jsonb,desired_state=desired where id=p_computer;
  end if;
  return jsonb_build_object('status',outcome,'action',p_action,'claimId',op,'customerId',p_customer,'computerId',p_computer,
    'operationId',op,'operatorId',binding.operator_id,'connectionId',binding.connection_id,
    'targetId',binding.target_id,'revision',binding.connection_revision,'sandboxId',agent.gvisor_sandbox_id,
    'adapterSha',agent.gvisor_adapter_sha256,'runtimeSha',agent.gvisor_runtime_sha256,'cpu',agent.cpu,'ram',agent.ram);
end $$;

-- Only the server's exact adapter result can advance the matching operation.
-- The same transaction publishes the housing state and its owner audit event.
create function public.complete_hivra_managed_gvisor_lifecycle(
  p_customer text,p_computer uuid,p_operation uuid,p_action text,p_receipt jsonb
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  agent public.hivra_agents%rowtype;
  binding public.hivra_managed_gvisor_bindings%rowtype;
  observed text;
  settled text;
  audit_event text;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  select * into agent from public.hivra_agents where id=p_computer and user_id=p_customer
    and computer_substrate='gvisor' and deployment_mode='hivra-managed' for update;
  if not found then return null; end if;
  select * into binding from public.hivra_managed_gvisor_bindings where computer_id=p_computer and customer_id=p_customer for update;
  if (binding.lifecycle_operation_id=p_operation and binding.lifecycle_action=p_action) is not true then return null; end if;
  settled := case p_action when 'start' then 'running' when 'stop' then 'stopped' when 'delete' then 'deleted' end;
  observed := case when settled='deleted' then 'absent' else settled end;
  if (p_receipt=case when observed='absent' then
    jsonb_build_object('version',1,'state','absent','computerId',agent.id,'sandboxId',agent.gvisor_sandbox_id)
  else
    jsonb_build_object('version',1,'state',observed,'computerId',agent.id,'sandboxId',agent.gvisor_sandbox_id,
      'cpu',agent.cpu,'memoryMb',agent.ram*1024,'adapterVersion',agent.gvisor_adapter_version,
      'isolationClass','application-kernel','isolationDriver','gvisor-runsc','outerHostBoundary','operator-owned-host',
      'runtime','runsc','reservationEqualsMaximum',true,'publicPorts','[]'::jsonb,
      'image','python:3.13-slim@sha256:9d2e5553305c7c7b0097999bb17187c69b921ccd6bc9d40e4bb5ebe652c00285',
      'workspace','hivra-gvisor-workspace-' || agent.gvisor_sandbox_id::text,
      'network','hivra-gvisor-net-' || agent.gvisor_sandbox_id::text)
  end) is not true then return null; end if;
  if agent.operation_id is null and agent.status=settled and binding.lifecycle_receipt=p_receipt then
    return to_jsonb(agent);
  end if;
  if (agent.operation_id=p_operation and agent.operation_kind=p_action and agent.desired_state=settled
    and binding.active_target_id=binding.target_id and binding.lifecycle_receipt is null) is not true
  then return null; end if;

  update public.hivra_managed_gvisor_bindings set lifecycle_receipt=p_receipt,
    active_target_id=case when settled='deleted' then null else active_target_id end,
    absence_receipt=case when settled='deleted' then p_receipt else absence_receipt end where computer_id=p_computer;
  update public.hivra_agents set status=settled,operation_id=null,operation_kind=null,
    operation_started_at=null,operation_payload=null where id=p_computer returning * into strict agent;
  audit_event := case p_action when 'start' then 'started' when 'stop' then 'stopped' else 'deleted' end;
  insert into public.hivra_agent_events(agent_id,user_id,event,agent_type,detail)
    values (p_computer,p_customer,audit_event,agent.type,jsonb_build_object('operationId',p_operation,'substrate','gvisor'));
  return to_jsonb(agent);
end $$;

revoke all on function public.claim_hivra_managed_gvisor_lifecycle(text,uuid,text),
  public.complete_hivra_managed_gvisor_lifecycle(text,uuid,uuid,text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.claim_hivra_managed_gvisor_lifecycle(text,uuid,text),
  public.complete_hivra_managed_gvisor_lifecycle(text,uuid,uuid,text,jsonb) to service_role;
