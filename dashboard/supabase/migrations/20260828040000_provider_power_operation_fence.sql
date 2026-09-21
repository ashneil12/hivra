-- Private provider power operations within the existing agent lifecycle.
-- No public launch admission, provider request or automatic hard power-off.
create table public.hivra_provider_power_operations (
  agent_id uuid not null references public.hivra_agents(id),
  operation_id uuid not null,
  user_id text not null,
  operation_kind text not null check(operation_kind in ('start','stop','restart')),
  connection_id uuid not null,
  connection_revision bigint not null check(connection_revision>0),
  capacity_order_id uuid not null,
  provider_server_id text not null,
  allocation_operation_id uuid not null,
  original_status text not null check(original_status in ('running','stopped')),
  created_at timestamptz not null,
  dispatch_not_after timestamptz not null,
  dispatch_intent_at timestamptz,
  before_boot_id uuid,
  action_receipt jsonb,
  verified_at timestamptz,
  verified_status text check(verified_status in ('running','off')),
  verified_boot_id uuid,
  cancelled_at timestamptz,
  primary key(agent_id,operation_id),
  check(dispatch_not_after=created_at+interval '45 seconds')
);
alter table public.hivra_provider_power_operations enable row level security;
revoke all on public.hivra_provider_power_operations from public,anon,authenticated;
grant select,insert,update on public.hivra_provider_power_operations to service_role;

create function public.hivra_provider_power_action_valid(p_action jsonb,p_server_id text,p_kind text)
returns boolean language plpgsql immutable security invoker set search_path=public,pg_temp as $$
declare resource jsonb; action_id numeric; server_id numeric;
begin
  if (jsonb_typeof(p_action)='object'
    and p_action-array['id','command','status','resources']='{}'::jsonb
    and jsonb_typeof(p_action->'id')='number'
    and p_action->>'status' in ('running','success','error')
    and p_action->>'command'=case p_kind when 'start' then 'start_server'
      when 'stop' then 'shutdown_server' when 'restart' then 'reboot_server' end
    and jsonb_typeof(p_action->'resources')='array'
    and p_server_id ~ '^[1-9][0-9]{0,15}$') is not true then return false; end if;
  if jsonb_array_length(p_action->'resources')<>1 then return false; end if;
  resource := p_action->'resources'->0;
  if (jsonb_typeof(resource)='object' and resource-array['id','type']='{}'::jsonb
    and jsonb_typeof(resource->'id')='number' and resource->>'type'='server') is not true then return false; end if;
  action_id := (p_action->>'id')::numeric;
  server_id := (resource->>'id')::numeric;
  return action_id>0 and action_id<=9007199254740991 and action_id=trunc(action_id)
    and server_id>0 and server_id<=9007199254740991 and server_id=trunc(server_id)
    and server_id=p_server_id::numeric;
end;
$$;

create function public.guard_hivra_provider_power_journal()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if tg_op='DELETE' then raise exception 'Retain provider power evidence' using errcode='55006'; end if;
  select * into a from public.hivra_agents where id=new.agent_id and user_id=new.user_id;
  if not found or a.computer_substrate<>'provider-vm'
    or row(new.connection_id,new.connection_revision,new.capacity_order_id,new.provider_server_id,new.allocation_operation_id)
      is distinct from row(a.infrastructure_connection_id,a.infrastructure_connection_revision,
        a.provider_capacity_order_id,a.provider_server_id,a.allocation_operation_id) then
    raise exception 'Provider power identity changed' using errcode='55006'; end if;
  if tg_op='INSERT' then
    if a.operation_id is not null or a.status not in ('running','stopped') or a.desired_state='deleted'
      or (new.operation_kind='start' and a.status<>'stopped')
      or (new.operation_kind<>'start' and a.status<>'running')
      or new.original_status<>a.status or new.created_at<clock_timestamp()-interval '5 seconds'
      or new.created_at>clock_timestamp() or new.dispatch_intent_at is not null
      or new.before_boot_id is not null or new.action_receipt is not null or new.verified_at is not null
      or new.verified_status is not null or new.verified_boot_id is not null or new.cancelled_at is not null then
      raise exception 'Reserve original power intent before dispatch' using errcode='55006'; end if;
    return new;
  end if;
  if row(new.agent_id,new.operation_id,new.user_id,new.operation_kind,new.connection_id,
      new.connection_revision,new.capacity_order_id,new.provider_server_id,new.allocation_operation_id,
      new.original_status,new.created_at,new.dispatch_not_after)
    is distinct from row(old.agent_id,old.operation_id,old.user_id,old.operation_kind,old.connection_id,
      old.connection_revision,old.capacity_order_id,old.provider_server_id,old.allocation_operation_id,
      old.original_status,old.created_at,old.dispatch_not_after)
    or a.operation_id is distinct from old.operation_id or a.operation_kind is distinct from old.operation_kind
    or a.status is distinct from 'provisioning' then
    raise exception 'Retain original provider power operation' using errcode='55006'; end if;
  if old.cancelled_at is not null and new is distinct from old then
    raise exception 'Retain cancelled power evidence' using errcode='55006'; end if;
  if old.dispatch_intent_at is null and new.dispatch_intent_at is not null then
    if clock_timestamp()>=old.dispatch_not_after or new.dispatch_intent_at<clock_timestamp()-interval '5 seconds'
      or new.dispatch_intent_at>clock_timestamp() or a.desired_state='deleted'
      or old.cancelled_at is not null
      or (new.operation_kind='restart') is distinct from (new.before_boot_id is not null) then
      raise exception 'Provider power dispatch window expired' using errcode='55006'; end if;
  elsif row(new.dispatch_intent_at,new.before_boot_id) is distinct from row(old.dispatch_intent_at,old.before_boot_id) then
    raise exception 'Do not renew power dispatch authority' using errcode='55006'; end if;
  if new.action_receipt is distinct from old.action_receipt then
    if new.dispatch_intent_at is null or new.cancelled_at is not null
      or not public.hivra_provider_power_action_valid(new.action_receipt,new.provider_server_id,new.operation_kind)
      or (old.action_receipt is not null and
        (new.action_receipt->'id' is distinct from old.action_receipt->'id'
          or (old.action_receipt->>'status'<>'running' and new.action_receipt is distinct from old.action_receipt))) then
      raise exception 'Provider power action receipt changed' using errcode='55006'; end if;
  end if;
  if row(new.verified_at,new.verified_status,new.verified_boot_id)
    is distinct from row(old.verified_at,old.verified_status,old.verified_boot_id) then
    if new.verified_at is null or new.action_receipt->>'status' is distinct from 'success'
      or new.verified_at<clock_timestamp()-interval '30 seconds' or new.verified_at>clock_timestamp()+interval '5 seconds'
      or new.verified_at<new.dispatch_intent_at-interval '5 seconds'
      or (old.verified_at is not null and new.verified_at<old.verified_at)
      or (new.operation_kind='stop' and (new.verified_status is distinct from 'off' or new.verified_boot_id is not null))
      or (new.operation_kind<>'stop' and (new.verified_status is distinct from 'running' or new.verified_boot_id is null))
      or (new.operation_kind='restart' and new.verified_boot_id is not distinct from new.before_boot_id) then
      raise exception 'Provider power result is not verified' using errcode='55006'; end if;
  end if;
  if new.cancelled_at is distinct from old.cancelled_at and (new.cancelled_at is null
    or old.cancelled_at is not null or new.dispatch_intent_at is not null
    or new.cancelled_at<clock_timestamp()-interval '5 seconds' or new.cancelled_at>clock_timestamp()) then
    raise exception 'A dispatched power request cannot be cancelled as unstarted' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger hivra_provider_power_journal_guard before insert or update or delete on public.hivra_provider_power_operations
  for each row execute function public.guard_hivra_provider_power_journal();

-- Shared finalizers and older application writers must obey the same proof.
create function public.guard_hivra_provider_power_lifecycle()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare j public.hivra_provider_power_operations%rowtype; clearing boolean;
begin
  if old.computer_substrate<>'provider-vm' then return new; end if;
  if old.operation_kind in ('start','stop','restart') then
    select * into j from public.hivra_provider_power_operations where agent_id=old.id and operation_id=old.operation_id;
    if not found then raise exception 'Provider power journal is required' using errcode='55006'; end if;
    clearing := new.operation_id is null and new.operation_kind is null
      and new.operation_started_at is null and new.operation_payload is null;
    if row(new.cpu,new.ram) is distinct from row(old.cpu,old.ram)
      or (old.desired_state='deleted' and new.desired_state<>'deleted') then
      raise exception 'Power cannot resize or override deletion' using errcode='55006'; end if;
    if not clearing then
      if row(new.operation_id,new.operation_kind,new.operation_started_at,new.operation_payload,new.status)
        is distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.operation_payload,old.status)
        or new.desired_state not in (old.desired_state,'deleted') then
        raise exception 'Retain active provider power operation' using errcode='55006'; end if;
      return new;
    end if;
    if j.cancelled_at is not null and j.dispatch_intent_at is null and new.status=j.original_status
      and new.desired_state=(case when old.desired_state='deleted' then 'deleted' else j.original_status end) then return new; end if;
    if old.desired_state='deleted' and new.desired_state='deleted' and new.status=old.status
      and j.action_receipt->>'status' in ('success','error') then return new; end if;
    if new.status='error' and new.desired_state=old.desired_state and j.action_receipt->>'status'='error' then return new; end if;
    if j.verified_at is not null and j.verified_at>=clock_timestamp()-interval '30 seconds'
      and j.action_receipt->>'status'='success' and old.desired_state<>'deleted'
      and new.status=(case when j.operation_kind='stop' then 'stopped' else 'running' end)
      and new.desired_state=new.status then return new; end if;
    raise exception 'Verify actual power result before releasing the operation' using errcode='55006';
  end if;
  if new.operation_kind in ('start','stop','restart') then
    select * into j from public.hivra_provider_power_operations where agent_id=new.id and operation_id=new.operation_id;
    if not found or j.user_id<>new.user_id or j.operation_kind<>new.operation_kind
      or j.original_status<>old.status or j.created_at<>new.operation_started_at
      or old.operation_id is not null or old.desired_state='deleted' or new.status<>'provisioning'
      or new.operation_payload is not null or j.dispatch_intent_at is not null or j.cancelled_at is not null
      or new.desired_state<>(case when new.operation_kind='stop' then 'stopped' else 'running' end) then
      raise exception 'Claim provider power atomically before dispatch' using errcode='55006'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_power_guard before update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_power_lifecycle();

create function public.claim_hivra_provider_power_operation(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_kind text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; original public.hivra_agents%rowtype; v_now timestamptz;
begin
  if (p_operation_id is not null and p_kind in ('start','stop','restart')) is not true then return false; end if;
  select * into original from public.hivra_agents where id=p_agent_id and user_id=p_user_id and computer_substrate='provider-vm';
  if not found then return false; end if;
  -- Parent-first order matches preparation/retirement. Recheck the immutable
  -- agent binding after its row lock; do not hold an agent lock while waiting
  -- for a new parent mutation lock.
  perform id from public.infrastructure_connections where id=original.infrastructure_connection_id
    and user_id=p_user_id and provider='hetzner-cloud' and status='ready'
    and revision=original.infrastructure_connection_revision for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=original.provider_capacity_order_id
    and user_id=p_user_id and active_connection_id=original.infrastructure_connection_id
    and connection_revision=original.infrastructure_connection_revision and provider_resource_id=original.provider_server_id
    and status='created_off' for update;
  if not found then return false; end if;
  perform id from public.deployment_targets where id=original.deployment_target_id and user_id=p_user_id
    and connection_id=original.infrastructure_connection_id and evidence_connection_revision=original.infrastructure_connection_revision
    and provider_capacity_order_id=original.provider_capacity_order_id and external_id=original.provider_server_id
    and provider_retired_at is null and status='ready' and isolation_class='provider-vm'
    and capabilities->'launchReady'='true'::jsonb for update;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.computer_substrate<>'provider-vm' or a.desired_state='deleted'
    or row(a.infrastructure_connection_id,a.infrastructure_connection_revision,a.deployment_target_id,a.provider_capacity_order_id,a.provider_server_id)
      is distinct from row(original.infrastructure_connection_id,original.infrastructure_connection_revision,
        original.deployment_target_id,original.provider_capacity_order_id,original.provider_server_id)
    or a.provider_install_outcome is distinct from 'succeeded' or a.provider_install_stopped_at is null then return false; end if;
  if a.operation_id is not null then return a.operation_id=p_operation_id and a.operation_kind=p_kind
    and exists(select 1 from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id and operation_kind=p_kind); end if;
  if (p_kind='start' and a.status<>'stopped') or (p_kind<>'start' and a.status<>'running')
    or exists(select 1 from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id) then return false; end if;
  v_now := clock_timestamp();
  insert into public.hivra_provider_power_operations(agent_id,operation_id,user_id,operation_kind,connection_id,
    connection_revision,capacity_order_id,provider_server_id,allocation_operation_id,original_status,created_at,dispatch_not_after)
    values(a.id,p_operation_id,a.user_id,p_kind,a.infrastructure_connection_id,a.infrastructure_connection_revision,
      a.provider_capacity_order_id,a.provider_server_id,a.allocation_operation_id,a.status,v_now,v_now+interval '45 seconds');
  update public.hivra_agents set status='provisioning',desired_state=case when p_kind='stop' then 'stopped' else 'running' end,
    operation_id=p_operation_id,operation_kind=p_kind,operation_started_at=v_now,operation_payload=null,error=null where id=a.id;
  return true;
end;
$$;

create function public.begin_hivra_provider_power_dispatch(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_before_boot_id uuid)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_power_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and status='provisioning' and computer_substrate='provider-vm' for update;
  if not found then return 'rejected'; end if;
  select * into j from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id for update;
  if not found or j.operation_kind is distinct from a.operation_kind or j.cancelled_at is not null then return 'rejected'; end if;
  if j.dispatch_intent_at is not null then return 'observe'; end if;
  if a.desired_state='deleted' or clock_timestamp()>=j.dispatch_not_after
    or (j.operation_kind='restart') is distinct from (p_before_boot_id is not null) then return 'rejected'; end if;
  update public.hivra_provider_power_operations set dispatch_intent_at=clock_timestamp(),before_boot_id=p_before_boot_id
    where agent_id=a.id and operation_id=p_operation_id;
  return 'dispatch';
end;
$$;

create function public.record_hivra_provider_power_action(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_action jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_power_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and status='provisioning' and computer_substrate='provider-vm' for update;
  if not found then return false; end if;
  select * into j from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id for update;
  if not found or j.dispatch_intent_at is null or j.cancelled_at is not null
    or not public.hivra_provider_power_action_valid(p_action,j.provider_server_id,j.operation_kind) then return false; end if;
  if j.action_receipt is not null then
    if j.action_receipt->'id' is distinct from p_action->'id' then return false; end if;
    if j.action_receipt->>'status'<>'running' then return j.action_receipt=p_action; end if;
  end if;
  update public.hivra_provider_power_operations set action_receipt=p_action where agent_id=a.id and operation_id=p_operation_id;
  return true;
end;
$$;

create function public.verify_hivra_provider_power_result(p_user_id text,p_agent_id uuid,p_operation_id uuid,
  p_observed_at timestamptz,p_status text,p_boot_id uuid,p_runtime_ready boolean,p_public_ready boolean)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_power_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and status='provisioning' and computer_substrate='provider-vm' for update;
  if not found or a.desired_state='deleted' then return false; end if;
  select * into j from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id for update;
  if not found or j.action_receipt->>'status' is distinct from 'success' or p_observed_at is null
    or p_observed_at<clock_timestamp()-interval '30 seconds' or p_observed_at>clock_timestamp()+interval '5 seconds'
    or (j.verified_at is not null and p_observed_at<j.verified_at) then return false; end if;
  if j.operation_kind='stop' then
    if p_status is distinct from 'off' or p_boot_id is not null
      or p_runtime_ready is distinct from false or p_public_ready is distinct from false then return false; end if;
  elsif p_status is distinct from 'running' or p_boot_id is null
    or p_runtime_ready is distinct from true or p_public_ready is distinct from true
    or (j.operation_kind='restart' and p_boot_id is not distinct from j.before_boot_id) then return false;
  end if;
  update public.hivra_provider_power_operations set verified_at=p_observed_at,verified_status=p_status,verified_boot_id=p_boot_id
    where agent_id=a.id and operation_id=p_operation_id;
  return true;
end;
$$;

create function public.cancel_hivra_provider_power_before_dispatch(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; j public.hivra_provider_power_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and status='provisioning' and computer_substrate='provider-vm' for update;
  if not found then return false; end if;
  select * into j from public.hivra_provider_power_operations where agent_id=a.id and operation_id=p_operation_id for update;
  if not found or j.dispatch_intent_at is not null then return false; end if;
  update public.hivra_provider_power_operations set cancelled_at=clock_timestamp() where agent_id=a.id and operation_id=p_operation_id;
  update public.hivra_agents set status=j.original_status,
    desired_state=case when desired_state='deleted' then 'deleted' else j.original_status end,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null where id=a.id;
  return true;
end;
$$;

revoke all on function public.hivra_provider_power_action_valid(jsonb,text,text) from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_power_journal() from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_power_lifecycle() from public,anon,authenticated;
revoke all on function public.claim_hivra_provider_power_operation(text,uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_power_dispatch(text,uuid,uuid,uuid) from public,anon,authenticated;
revoke all on function public.record_hivra_provider_power_action(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.verify_hivra_provider_power_result(text,uuid,uuid,timestamptz,text,uuid,boolean,boolean) from public,anon,authenticated;
revoke all on function public.cancel_hivra_provider_power_before_dispatch(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.hivra_provider_power_action_valid(jsonb,text,text),public.guard_hivra_provider_power_journal(),
  public.guard_hivra_provider_power_lifecycle(),public.claim_hivra_provider_power_operation(text,uuid,uuid,text),
  public.begin_hivra_provider_power_dispatch(text,uuid,uuid,uuid),public.record_hivra_provider_power_action(text,uuid,uuid,jsonb),
  public.verify_hivra_provider_power_result(text,uuid,uuid,timestamptz,text,uuid,boolean,boolean),
  public.cancel_hivra_provider_power_before_dispatch(text,uuid,uuid) to service_role;
