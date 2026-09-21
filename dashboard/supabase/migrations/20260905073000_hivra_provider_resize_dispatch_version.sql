-- Retained Vercel deployments must never resume paid dispatch with the old
-- receipt parser after the canonical command/shutdown cutover. Keep their RPC
-- as a nonmutating tombstone, even if an old grant is accidentally restored.
create or replace function public.begin_hivra_provider_resize_dispatch(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns text language sql security invoker set search_path=public,pg_temp
as $$ select 'rejected'::text $$;
revoke all on function public.begin_hivra_provider_resize_dispatch(text,uuid,uuid) from public,anon,authenticated,service_role;

-- Original one-use dispatch mechanics; only the compatible application calls
-- this version. This is a compatibility gate, not an additional authorization.
create function public.begin_hivra_provider_resize_dispatch_v2(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare a public.hivra_agents%rowtype; q public.hivra_provider_resize_operations%rowtype; v_now timestamptz;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  select * into q from public.hivra_provider_resize_operations
    where operation_id=p_operation_id and agent_id=p_agent_id and user_id=p_user_id for update;
  if not found or a.operation_id is distinct from q.operation_id or a.operation_kind<>'resize'
    or a.status<>'provisioning' then return 'rejected'; end if;
  if q.status<>'dispatch_pending' then return 'observe'; end if;
  perform id from public.infrastructure_capacity_orders where id=q.capacity_order_id and user_id=p_user_id
    and provider_resource_id=q.provider_server_id
    and coalesce(current_server_shape_fingerprint_sha256,quote_fingerprint_sha256)=q.source_shape_fingerprint_sha256
    for update;
  if not found then return 'rejected'; end if;
  if a.desired_state='deleted' or a.desired_state<>'stopped' or q.provider_post_attempted_at is not null
    or clock_timestamp()>=q.dispatch_not_after then return 'rejected'; end if;
  v_now:=clock_timestamp();
  update public.hivra_provider_resize_operations set status='request_uncertain',provider_post_attempted_at=v_now,
    updated_at=v_now where operation_id=q.operation_id;
  return 'dispatch';
end;
$$;
revoke all on function public.begin_hivra_provider_resize_dispatch_v2(text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.begin_hivra_provider_resize_dispatch_v2(text,uuid,uuid) to service_role;
