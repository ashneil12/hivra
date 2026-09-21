-- Preserve the confirmed stopped-after-resize result when the provider starts
-- the guest after migration. One durable shutdown marker; never a retry queue.
alter table public.hivra_provider_resize_operations
  add column shutdown_attempted_at timestamptz,
  add column shutdown_action jsonb;

create function public.guard_hivra_provider_resize_shutdown()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.shutdown_attempted_at is not null or new.shutdown_action is not null then
      raise exception 'Resize shutdown must follow verified migration';
    end if;
    return new;
  end if;
  if old.shutdown_attempted_at is not null
    and new.shutdown_attempted_at is distinct from old.shutdown_attempted_at then
    raise exception 'Retain the one-use resize shutdown marker';
  end if;
  if new.shutdown_attempted_at is distinct from old.shutdown_attempted_at then
    if new.shutdown_attempted_at is null
      or old.status<>'provider_pending' or new.status<>'provider_pending'
      or old.provider_action->>'status' is distinct from 'success'
      or old.provider_observed_status is distinct from 'running'
      or old.provider_observed_at is null
      or old.provider_observed_at<clock_timestamp()-interval '15 seconds'
      or old.provider_observed_at>clock_timestamp()+interval '5 seconds'
      or old.provider_observed_server_type_id is distinct from (old.quote_snapshot#>>'{target,serverTypeId}')::bigint
      or old.provider_observed_server_type is distinct from old.quote_snapshot#>>'{target,serverType}'
      or old.provider_observed_architecture is distinct from old.quote_snapshot#>>'{target,architecture}'
      or old.provider_observed_cores is distinct from (old.quote_snapshot#>>'{target,cores}')::integer
      or old.provider_observed_memory_gb is distinct from (old.quote_snapshot#>>'{target,memoryGb}')::integer
      or old.provider_observed_advertised_disk_gb is distinct from (old.quote_snapshot#>>'{target,advertisedDiskGb}')::bigint
      or old.provider_observed_cpu_type is distinct from old.quote_snapshot#>>'{target,cpuType}'
      or old.provider_observed_disk_gb is distinct from (old.quote_snapshot->>'existingDiskGb')::bigint
      or new.shutdown_attempted_at<clock_timestamp()-interval '5 seconds'
      or new.shutdown_attempted_at>clock_timestamp()+interval '5 seconds'
    then raise exception 'Shutdown requires the fresh exact resized running server'; end if;
  end if;
  if new.shutdown_action is not null then
    if new.shutdown_attempted_at is null
      or new.shutdown_action->>'command' is distinct from 'shutdown_server'
      or public.hivra_provider_resize_action_valid(
        jsonb_set(new.shutdown_action,'{command}','"change_server_type"'),new.provider_server_id) is distinct from true
    then raise exception 'Invalid resize shutdown receipt'; end if;
  end if;
  if old.shutdown_action is not null and (
    new.shutdown_action is null
    or new.shutdown_action->'id' is distinct from old.shutdown_action->'id'
    or new.shutdown_action->'resources' is distinct from old.shutdown_action->'resources'
    or (old.shutdown_action->>'status'<>'running' and new.shutdown_action is distinct from old.shutdown_action)
  ) then raise exception 'Retain the original resize shutdown receipt'; end if;
  if new.status='succeeded' and new.shutdown_attempted_at is not null
    and new.shutdown_action->>'status' is distinct from 'success' then
    raise exception 'Reconcile the original shutdown before releasing the computer';
  end if;
  return new;
end;
$$;

create trigger hivra_provider_resize_shutdown_guard before insert or update
  on public.hivra_provider_resize_operations for each row
  execute function public.guard_hivra_provider_resize_shutdown();

create function public.begin_hivra_provider_resize_shutdown(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_provider_resize_operations%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from q.operation_id
    or a.operation_kind is distinct from 'resize' or a.status is distinct from 'provisioning'
    or a.desired_state is distinct from 'stopped' then return 'rejected'; end if;
  if q.shutdown_attempted_at is not null then return 'observe'; end if;
  if q.status<>'provider_pending' then return 'rejected'; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256 for update;
  if not found then return 'rejected'; end if;
  -- Existing journal guard rechecks owner, connection, allocation and binding;
  -- the shutdown guard checks exact fresh target geometry and terminal resize.
  update public.hivra_provider_resize_operations set shutdown_attempted_at=clock_timestamp(),
    updated_at=clock_timestamp() where operation_id=q.operation_id;
  return 'dispatch';
end;
$$;

create function public.record_hivra_provider_resize_shutdown(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_action jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare q public.hivra_provider_resize_operations%rowtype;
begin
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or q.status not in ('action_pending','provider_pending','manual_attention')
    or q.shutdown_attempted_at is null then return false; end if;
  update public.hivra_provider_resize_operations set shutdown_action=p_action,
    updated_at=clock_timestamp() where operation_id=q.operation_id;
  return true;
end;
$$;

revoke all on function public.guard_hivra_provider_resize_shutdown() from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_resize_shutdown(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.record_hivra_provider_resize_shutdown(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.begin_hivra_provider_resize_shutdown(text,uuid,uuid) to service_role;
grant execute on function public.record_hivra_provider_resize_shutdown(text,uuid,uuid,jsonb) to service_role;
