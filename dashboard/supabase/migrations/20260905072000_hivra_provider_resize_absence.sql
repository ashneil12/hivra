-- A removed original server is neither a successful resize nor a rejected one.
-- Preserve its journal and hand explicit deletion to the existing five-resource
-- cleanup coordinator. Never infer remaining-resource absence from server absence.
alter table public.hivra_provider_resize_operations add column provider_server_absent_at timestamptz;
alter table public.hivra_provider_resize_operations
  drop constraint hivra_provider_resize_operations_status_check,
  add constraint hivra_provider_resize_operations_status_check check (status in
    ('quoted','dispatch_pending','request_uncertain','action_pending','provider_pending','manual_attention','succeeded','failed','cancelled','removed')),
  drop constraint hivra_provider_resize_stage_check,
  add constraint hivra_provider_resize_stage_check check (
    (status = 'quoted' and billing_confirmed_at is null and dispatch_not_after is null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is null and failure_code is null)
    or (status = 'dispatch_pending' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is null and failure_code is null)
    or (status = 'request_uncertain' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and provider_action is null
      and completed_at is null and failure_code is null)
    or (status = 'action_pending' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and provider_action is not null
      and completed_at is null and failure_code is null)
    or (status in ('provider_pending','manual_attention')
      and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is not null and completed_at is null and failure_code is null)
    or (status = 'succeeded' and billing_confirmed_at is not null and provider_post_attempted_at is not null
      and provider_observed_at is not null and completed_at is not null and failure_code is null)
    or (status = 'failed' and billing_confirmed_at is not null and provider_post_attempted_at is not null
      and provider_action->>'status' is not distinct from 'error' and provider_observed_at is not null
      and completed_at is not null and failure_code is not null)
    or (status = 'cancelled' and billing_confirmed_at is not null and dispatch_not_after is not null
      and provider_post_attempted_at is null and provider_action is null and provider_observed_at is null
      and completed_at is not null and failure_code is not null)
    or (status='removed' and billing_confirmed_at is not null and provider_post_attempted_at is not null
      and provider_server_absent_at is not null and completed_at is not null
      and failure_code is not distinct from 'provider_server_absent')
  ),
  add constraint hivra_provider_resize_removed_absence_check check ((status='removed')=(provider_server_absent_at is not null));

create or replace function public.guard_hivra_provider_resize_journal()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  a public.hivra_agents%rowtype;
begin
  if tg_op = 'DELETE' then
    raise exception 'Retain provider resize evidence' using errcode = '55006';
  end if;
  select * into a from public.hivra_agents where id = new.agent_id and user_id = new.user_id;
  if not found or public.hivra_provider_resize_binding_valid(new.user_id,new.agent_id,new.connection_id,
      new.connection_revision,new.deployment_target_id,new.capacity_order_id,new.enrollment_attempt_id,
      new.allocation_operation_id,new.provider_server_id) is distinct from true then
    raise exception 'Provider resize identity changed' using errcode = '55006';
  end if;
  if tg_op = 'INSERT' then
    if new.provider_server_absent_at is not null or new.status <> 'quoted' or a.status <> 'stopped' or a.desired_state <> 'stopped' or a.operation_id is not null
      or new.quote_observed_at < clock_timestamp() - interval '30 seconds'
      or new.quote_observed_at > clock_timestamp() + interval '5 seconds'
      or new.created_at < clock_timestamp() - interval '30 seconds' or new.created_at > clock_timestamp() + interval '5 seconds'
    then
      raise exception 'Reserve a fresh provider resize quote' using errcode = '55006';
    end if;
    return new;
  end if;
  if row(new.operation_id,new.agent_id,new.user_id,new.connection_id,new.connection_revision,new.deployment_target_id,
      new.capacity_order_id,new.enrollment_attempt_id,new.allocation_operation_id,new.provider_server_id,
      new.source_shape_fingerprint_sha256,
      new.plan_fingerprint_sha256,new.quote_fingerprint_sha256,new.quote_snapshot,new.quote_observed_at,
      new.quote_expires_at,new.created_at)
    is distinct from row(old.operation_id,old.agent_id,old.user_id,old.connection_id,old.connection_revision,old.deployment_target_id,
      old.capacity_order_id,old.enrollment_attempt_id,old.allocation_operation_id,old.provider_server_id,
      old.source_shape_fingerprint_sha256,
      old.plan_fingerprint_sha256,old.quote_fingerprint_sha256,old.quote_snapshot,old.quote_observed_at,
      old.quote_expires_at,old.created_at)
  then
    raise exception 'Retain the reviewed provider resize quote' using errcode = '55006';
  end if;
  if old.status in ('succeeded','failed','cancelled','removed') and new is distinct from old then
    raise exception 'Retain terminal provider resize evidence' using errcode = '55006';
  end if;
  if new.updated_at < old.updated_at or new.updated_at > clock_timestamp() + interval '5 seconds' then
    raise exception 'Provider resize evidence cannot move backwards' using errcode = '55006';
  end if;
  if old.status = 'quoted' then
    if new.status <> 'dispatch_pending' or a.operation_id is not null or a.status <> 'stopped' or a.desired_state <> 'stopped'
      or new.billing_confirmed_at is null or new.dispatch_not_after is distinct from new.billing_confirmed_at + interval '45 seconds'
      or new.billing_confirmed_at < clock_timestamp() - interval '5 seconds'
      or new.billing_confirmed_at > clock_timestamp() + interval '5 seconds'
    then raise exception 'Confirm billing before resize dispatch' using errcode = '55006'; end if;
  elsif old.status = 'dispatch_pending' then
    if new.status not in ('request_uncertain','cancelled')
    then raise exception 'Invalid provider resize dispatch transition' using errcode = '55006'; end if;
  elsif old.status in ('request_uncertain','action_pending','provider_pending','manual_attention') then
    if new.status not in ('request_uncertain','action_pending','provider_pending','manual_attention','succeeded','failed','removed')
    then raise exception 'Invalid provider resize observation transition' using errcode = '55006'; end if;
  else
    raise exception 'Invalid provider resize transition' using errcode = '55006';
  end if;
  if old.billing_confirmed_at is not null and row(new.billing_confirmed_at,new.dispatch_not_after)
      is distinct from row(old.billing_confirmed_at,old.dispatch_not_after) then
    raise exception 'Retain provider resize billing authority' using errcode = '55006';
  end if;
  if new.provider_post_attempted_at is distinct from old.provider_post_attempted_at then
    if old.provider_post_attempted_at is not null or old.status <> 'dispatch_pending'
      or new.status <> 'request_uncertain'
      or new.provider_post_attempted_at < new.billing_confirmed_at
      or new.provider_post_attempted_at >= new.dispatch_not_after
      or new.provider_post_attempted_at < clock_timestamp() - interval '5 seconds'
      or new.provider_post_attempted_at > clock_timestamp() + interval '5 seconds'
    then raise exception 'Provider resize request fence changed' using errcode = '55006'; end if;
  end if;
  if old.status <> 'quoted' and (
    a.operation_id is distinct from new.operation_id or a.operation_kind <> 'resize'
    or a.status <> 'provisioning' or a.desired_state not in ('stopped','deleted')
  ) then
    raise exception 'Provider resize no longer owns this computer' using errcode = '55006';
  end if;
  if new.provider_action is distinct from old.provider_action and old.provider_action is not null then
    if new.provider_action->'id' is distinct from old.provider_action->'id'
      or new.provider_action->>'command' is distinct from old.provider_action->>'command'
      or new.provider_action->'resources' is distinct from old.provider_action->'resources'
      or (old.provider_action->>'status' <> 'running' and new.provider_action is distinct from old.provider_action)
    then raise exception 'Provider resize action identity changed' using errcode = '55006'; end if;
  end if;
  if new.provider_action is distinct from old.provider_action and new.provider_post_attempted_at is null then
    raise exception 'Provider action lacks a dispatched request' using errcode = '55006';
  end if;
  if old.provider_observed_at is not null and new.provider_observed_at is not null
    and new.provider_observed_at < old.provider_observed_at then
    raise exception 'Provider resize observation moved backwards' using errcode = '55006';
  end if;
  if new.provider_observed_at is distinct from old.provider_observed_at and (
    new.provider_post_attempted_at is null
    or new.provider_observed_at < new.provider_post_attempted_at
    or new.provider_observed_at < clock_timestamp() - interval '30 seconds'
    or new.provider_observed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize observation is not fresh' using errcode = '55006';
  end if;
  if new.status = 'succeeded' and (
    new.provider_observed_status <> 'off'
    or new.provider_observed_server_type_id <> (new.quote_snapshot#>>'{target,serverTypeId}')::bigint
    or new.provider_observed_server_type is distinct from new.quote_snapshot#>>'{target,serverType}'
    or new.provider_observed_architecture is distinct from new.quote_snapshot#>>'{target,architecture}'
    or new.provider_observed_cores <> (new.quote_snapshot#>>'{target,cores}')::integer
    or new.provider_observed_memory_gb <> (new.quote_snapshot#>>'{target,memoryGb}')::integer
    or new.provider_observed_advertised_disk_gb <> (new.quote_snapshot#>>'{target,advertisedDiskGb}')::bigint
    or new.provider_observed_cpu_type is distinct from new.quote_snapshot#>>'{target,cpuType}'
    or new.provider_observed_disk_gb <> (new.quote_snapshot->>'existingDiskGb')::bigint
    -- The bound server is authoritative when an action receipt has aged out;
    -- only an explicit action error contradicts an exact target observation.
    or new.provider_action->>'status' = 'error'
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize success is not reconciled' using errcode = '55006';
  end if;
  if new.status = 'failed' and (
    new.provider_action->>'status' is distinct from 'error'
    or new.provider_observed_status <> 'off'
    or new.provider_observed_server_type_id <> (new.quote_snapshot#>>'{source,serverTypeId}')::bigint
    or new.provider_observed_server_type is distinct from new.quote_snapshot#>>'{source,serverType}'
    or new.provider_observed_architecture is distinct from new.quote_snapshot#>>'{source,architecture}'
    or new.provider_observed_cores <> (new.quote_snapshot#>>'{source,cores}')::integer
    or new.provider_observed_memory_gb <> (new.quote_snapshot#>>'{source,memoryGb}')::integer
    or new.provider_observed_advertised_disk_gb <> (new.quote_snapshot#>>'{source,advertisedDiskGb}')::bigint
    or new.provider_observed_cpu_type is distinct from new.quote_snapshot#>>'{source,cpuType}'
    or new.provider_observed_disk_gb <> (new.quote_snapshot->>'existingDiskGb')::bigint
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize failure is not reconciled' using errcode = '55006';
  end if;
  if new.status = 'cancelled' and (
    old.status <> 'dispatch_pending' or new.provider_post_attempted_at is not null
    or new.completed_at < clock_timestamp() - interval '5 seconds'
    or new.completed_at > clock_timestamp() + interval '5 seconds'
  ) then
    raise exception 'Provider resize cancellation is not pre-dispatch' using errcode = '55006';
  end if;
  if new.provider_server_absent_at is distinct from old.provider_server_absent_at then
    if old.provider_server_absent_at is not null or new.provider_server_absent_at is null
      or new.status<>'removed' or a.desired_state is distinct from 'deleted'
      or new.provider_post_attempted_at is null
      or new.provider_server_absent_at<clock_timestamp()-interval '15 seconds'
      or new.provider_server_absent_at>clock_timestamp()+interval '5 seconds'
      or new.completed_at<clock_timestamp()-interval '5 seconds'
      or new.completed_at>clock_timestamp()+interval '5 seconds'
    then raise exception 'Record fresh original server absence before handing resize to deletion'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.guard_hivra_provider_resize_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  j public.hivra_provider_resize_operations%rowtype;
  v_payload jsonb;
begin
  if old.computer_substrate <> 'provider-vm' then return new; end if;
  if old.operation_kind = 'resize' then
    select * into j from public.hivra_provider_resize_operations
      where agent_id = old.id and operation_id = old.operation_id;
    if not found then raise exception 'Provider resize journal is required' using errcode = '55006'; end if;
    if new.operation_id is null and new.operation_kind is null and new.operation_started_at is null and new.operation_payload is null then
      if new.status <> (case when j.status='removed' then 'error' else 'stopped' end)
        or (j.status='removed' and new.desired_state is distinct from 'deleted')
        or new.desired_state <> (case when old.desired_state = 'deleted' then 'deleted' else 'stopped' end)
        or (j.status = 'succeeded' and (new.cpu <> (j.quote_snapshot#>>'{target,cores}')::numeric
          or new.ram <> (j.quote_snapshot#>>'{target,memoryGb}')::integer))
        or (j.status in ('failed','cancelled','removed') and row(new.cpu,new.ram) is distinct from row(old.cpu,old.ram))
        or j.status not in ('succeeded','failed','cancelled','removed')
      then raise exception 'Verify provider resize before releasing its operation' using errcode = '55006'; end if;
      return new;
    end if;
    if new.desired_state = 'deleted'
      and old.desired_state = 'stopped'
      and row(new.operation_id,new.operation_kind,new.operation_started_at,new.operation_payload,new.status,new.cpu,new.ram)
        is not distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.operation_payload,old.status,old.cpu,old.ram)
    then return new; end if;
    if row(new.operation_id,new.operation_kind,new.operation_started_at,new.operation_payload,new.status,
        new.desired_state,new.cpu,new.ram)
      is distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.operation_payload,old.status,
        old.desired_state,old.cpu,old.ram)
    then raise exception 'Retain active provider resize authority' using errcode = '55006'; end if;
    return new;
  end if;
  if new.operation_kind = 'resize' then
    select * into j from public.hivra_provider_resize_operations
      where agent_id = new.id and operation_id = new.operation_id;
    v_payload := jsonb_build_object(
      'quoteFingerprint', j.quote_fingerprint_sha256,
      'sourceServerType', j.quote_snapshot#>>'{source,serverType}',
      'targetServerType', j.quote_snapshot#>>'{target,serverType}',
      'upgradeDisk', false
    );
    if not found or j.user_id <> new.user_id or j.status <> 'dispatch_pending'
      or old.operation_id is not null or old.status <> 'stopped' or old.desired_state <> 'stopped'
      or new.status <> 'provisioning' or new.desired_state <> 'stopped'
      or new.operation_started_at is distinct from j.billing_confirmed_at
      or new.operation_payload is distinct from v_payload
      or row(new.cpu,new.ram) is distinct from row(old.cpu,old.ram)
    then raise exception 'Claim the reviewed provider resize atomically' using errcode = '55006'; end if;
  end if;
  return new;
end;
$$;

create function public.record_hivra_provider_resize_server_absent(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_server_id text,p_observed_at timestamptz
)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_provider_resize_operations%rowtype; v_now timestamptz;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from q.operation_id
    or a.operation_kind is distinct from 'resize' or a.status is distinct from 'provisioning'
    or a.desired_state is distinct from 'deleted' or q.provider_server_id is distinct from p_server_id
    or q.status not in ('request_uncertain','action_pending','provider_pending','manual_attention')
    or q.provider_post_attempted_at is null or p_observed_at is null
    or p_observed_at<clock_timestamp()-interval '15 seconds' or p_observed_at>clock_timestamp()+interval '5 seconds'
  then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256 for update;
  if not found then return false; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='removed',provider_server_absent_at=p_observed_at,
    failure_code='provider_server_absent',completed_at=v_now,updated_at=v_now where operation_id=q.operation_id;
  update public.hivra_agents set status='error',error='The original provider server is absent. Remaining resource cleanup is requested.',
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
    where id=a.id and user_id=p_user_id;
  return true;
end;
$$;
revoke all on function public.record_hivra_provider_resize_server_absent(text,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.record_hivra_provider_resize_server_absent(text,uuid,uuid,text,timestamptz) to service_role;
