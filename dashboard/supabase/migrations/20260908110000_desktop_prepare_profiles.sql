-- The preparation lifecycle began as Ubuntu-only. Omarchy and Windows now
-- have their own strict guest preparation handlers, so admit those exact
-- implemented profiles into the same durable operation lease.

create or replace function public.begin_hivra_desktop_prepare(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_expected_authority jsonb)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; p public.hivra_desktop_preparations%rowtype;
begin
  if p_user_id is null or p_agent_id is null or p_operation_id is null or p_expected_authority is null then return null; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or public.hivra_desktop_prepare_authority(a) is distinct from p_expected_authority
    or a.status is distinct from 'running' or a.infrastructure_binding_token_enforced is distinct from true
    or a.computer_substrate is distinct from 'proxmox-kvm' or a.type is distinct from 'linux-desktop'
    or coalesce(a.computer_profile,'ubuntu-desktop') not in ('ubuntu-desktop','omarchy','windows')
    or a.vmid is null or a.ip is null
  then return null; end if;
  if a.operation_id is not null then
    select * into p from public.hivra_desktop_preparations where id=a.operation_id and user_id=p_user_id
      and agent_id=a.id and authority=p_expected_authority and phase in ('claimed','dispatched');
    if found and a.operation_kind='desktop_prepare' then
      return jsonb_build_object('operationId',p.id,'phase',p.phase,'resumed',true);
    end if;
    return null;
  end if;
  if a.desired_state is distinct from 'running' or not public.hivra_desktop_prepare_binding_ready(a) then return null; end if;
  update public.hivra_agents set operation_id=p_operation_id,operation_kind='desktop_prepare',
    operation_started_at=clock_timestamp(),operation_payload=jsonb_build_object('desktopPrepareId',p_operation_id::text),error=null
    where id=a.id;
  insert into public.hivra_desktop_preparations(id,agent_id,user_id,authority,phase)
    values(p_operation_id,a.id,p_user_id,p_expected_authority,'claimed');
  return jsonb_build_object('operationId',p_operation_id,'phase','claimed','resumed',false);
end;
$$;

revoke all on function public.begin_hivra_desktop_prepare(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.begin_hivra_desktop_prepare(text,uuid,uuid,jsonb) to service_role;
