-- A provider-running VM can still be booting without an ACPI listener. Keep
-- the one-use shutdown marker behind fresh evidence from the enrolled guest.
alter table public.hivra_provider_resize_operations
  add column shutdown_wait_started_at timestamptz,
  add column shutdown_readiness jsonb;

create function public.guard_hivra_provider_resize_readiness()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare r jsonb; seen timestamptz; needs_evidence boolean;
begin
  if tg_op='INSERT' then
    if new.shutdown_wait_started_at is not null or new.shutdown_readiness is not null then
      raise exception 'Readiness must follow the original resize';
    end if;
    return new;
  end if;
  if old.shutdown_wait_started_at is not null
    and new.shutdown_wait_started_at is distinct from old.shutdown_wait_started_at then
    raise exception 'Retain the original readiness deadline';
  end if;
  if old.shutdown_attempted_at is not null
    and new.shutdown_readiness is distinct from old.shutdown_readiness then
    raise exception 'Retain dispatched shutdown readiness';
  end if;
  needs_evidence := new.shutdown_readiness is distinct from old.shutdown_readiness
    or new.shutdown_wait_started_at is distinct from old.shutdown_wait_started_at
    or new.shutdown_attempted_at is distinct from old.shutdown_attempted_at;
  if not needs_evidence then return new; end if;
  if new.shutdown_wait_started_at is null
    or new.shutdown_wait_started_at>clock_timestamp()+interval '5 seconds'
    or (old.shutdown_wait_started_at is null and new.shutdown_wait_started_at<clock_timestamp()-interval '5 seconds')
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
  then raise exception 'Readiness requires the exact fresh resized running server'; end if;
  perform 1 from public.hivra_agents where id=new.agent_id and user_id=new.user_id
    and operation_id=new.operation_id and operation_kind='resize' and status='provisioning' and desired_state='stopped';
  if not found then raise exception 'Readiness requires the retained stopped-desired lease'; end if;
  if new.shutdown_readiness is null then
    if new.shutdown_attempted_at is distinct from old.shutdown_attempted_at then
      raise exception 'Shutdown requires enrolled guest readiness';
    end if;
    return new;
  end if;
  r := new.shutdown_readiness;
  if jsonb_typeof(r) is distinct from 'object'
    or r->'version' is distinct from '1'::jsonb
    or (select count(*) from jsonb_object_keys(r))<>5
    or jsonb_typeof(r->'observedAt') is distinct from 'string'
    or coalesce(r->>'bootId','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or jsonb_typeof(r->'powerHandlerPid') is distinct from 'number'
    or coalesce(r->>'powerHandlerPid','') !~ '^[1-9][0-9]{0,9}$'
    or (r->>'powerHandlerPid')::bigint>2147483647
    or jsonb_typeof(r->'hostFingerprintSha256') is distinct from 'string'
  then raise exception 'Invalid guest readiness receipt'; end if;
  seen := (r->>'observedAt')::timestamptz;
  if seen is null or seen<clock_timestamp()-interval '15 seconds' or seen>clock_timestamp()+interval '5 seconds'
    or seen<new.shutdown_wait_started_at-interval '5 seconds'
    or clock_timestamp()>=new.shutdown_wait_started_at+interval '120 seconds'
  then raise exception 'Guest readiness expired'; end if;
  perform 1 from public.infrastructure_first_boot_enrollments e
    join public.infrastructure_capacity_orders o on o.id=e.order_id
    where e.order_id=new.capacity_order_id and e.attempt_id=new.enrollment_attempt_id
      and e.user_id=new.user_id and e.connection_id=new.connection_id
      and e.connection_revision=new.connection_revision and e.provider_server_id=new.provider_server_id
      and e.phase='enrolled' and e.host_public_key is not null
      and e.host_fingerprint_sha256=r->>'hostFingerprintSha256'
      and e.quote_fingerprint_sha256=o.quote_fingerprint_sha256;
  if not found then raise exception 'Readiness must retain the original enrolled host'; end if;
  return new;
end;
$$;
create trigger hivra_provider_resize_readiness_guard before insert or update
  on public.hivra_provider_resize_operations for each row
  execute function public.guard_hivra_provider_resize_readiness();

create function public.record_hivra_provider_resize_readiness(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_readiness jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare q public.hivra_provider_resize_operations%rowtype;
begin
  perform 1 from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and operation_kind='resize' and status='provisioning' and desired_state='stopped' for update;
  if not found then return false; end if;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or q.status<>'provider_pending' or q.shutdown_attempted_at is not null then return false; end if;
  if q.shutdown_wait_started_at is not null and clock_timestamp()>=q.shutdown_wait_started_at+interval '120 seconds' then
    update public.hivra_provider_resize_operations set status='manual_attention',updated_at=clock_timestamp()
      where operation_id=q.operation_id;
    return false;
  end if;
  update public.hivra_provider_resize_operations set
    shutdown_wait_started_at=coalesce(shutdown_wait_started_at,clock_timestamp()),
    shutdown_readiness=p_readiness,updated_at=clock_timestamp() where operation_id=q.operation_id;
  return true;
end;
$$;

-- Retained deployments must not consume a readiness receipt without knowing
-- this protocol. The old endpoint is inert even for its owner role.
create or replace function public.begin_hivra_provider_resize_shutdown(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns text language sql security invoker set search_path=public,pg_temp as $$ select 'rejected'::text; $$;
revoke all on function public.begin_hivra_provider_resize_shutdown(text,uuid,uuid) from service_role;

create function public.begin_hivra_provider_resize_shutdown_v2(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_readiness jsonb)
returns text language plpgsql security invoker set search_path=public,pg_temp as $$
declare q public.hivra_provider_resize_operations%rowtype;
begin
  perform 1 from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and operation_kind='resize' and status='provisioning' and desired_state='stopped' for update;
  if not found then return 'rejected'; end if;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found then return 'rejected'; end if;
  if q.shutdown_attempted_at is not null then return 'observe'; end if;
  if q.status<>'provider_pending' or p_readiness is null or q.shutdown_readiness is distinct from p_readiness then return 'rejected'; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256 for update;
  if not found then return 'rejected'; end if;
  -- Both readiness and original shutdown triggers must accept this update.
  update public.hivra_provider_resize_operations set shutdown_attempted_at=clock_timestamp(),updated_at=clock_timestamp()
    where operation_id=q.operation_id;
  return 'dispatch';
end;
$$;
revoke all on function public.guard_hivra_provider_resize_readiness() from public,anon,authenticated;
revoke all on function public.record_hivra_provider_resize_readiness(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_resize_shutdown_v2(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.record_hivra_provider_resize_readiness(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.begin_hivra_provider_resize_shutdown_v2(text,uuid,uuid,jsonb) to service_role;
