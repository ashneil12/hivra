-- Desktop power convergence preserves the original v3 allocation and access.
-- The shared power journal/trigger still requires a fresh actual boot result.
create function public.complete_hivra_provider_desktop_power(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_kind text,p_chat_url text,p_ip text
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if p_kind is null or p_kind not in ('start','restart') then return false; end if;
  update public.hivra_agents set status='running',chat_url=p_chat_url,ip=p_ip,api_token=null,error=null,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
  where id=p_agent_id and user_id=p_user_id and operation_id=p_operation_id
    and operation_kind=p_kind and allocation_operation_id<>p_operation_id
    and desired_state='running' and status='provisioning'
    and type='linux-desktop' and computer_profile='ubuntu-desktop' and computer_substrate='provider-vm'
    and public.hivra_provider_desktop_identity_valid(provider_install_identity,id,allocation_operation_id)
    and provider_install_stopped_at is not null and provider_install_outcome='succeeded'
    and public.hivra_provider_desktop_access_matches(provider_install_desktop_access,hivra_agents)
    and p_chat_url is not null and p_chat_url='https://'||(provider_install_desktop_access->>'hostname')
    and p_ip is not null
    and exists(select 1 from public.infrastructure_capacity_orders o
      where o.id=hivra_agents.provider_capacity_order_id and o.user_id=hivra_agents.user_id
        and o.provider_resource_id=hivra_agents.provider_server_id
        and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=p_ip)
    and not exists(select 1 from public.hivra_provider_desktop_cleanup c
      where c.agent_id=hivra_agents.id and c.operation_id=hivra_agents.allocation_operation_id)
    and exists(select 1 from public.hivra_provider_power_operations j
      where j.agent_id=hivra_agents.id and j.operation_id=p_operation_id and j.user_id=p_user_id
        and j.operation_kind=p_kind and j.allocation_operation_id=hivra_agents.allocation_operation_id
        and j.verified_at>=clock_timestamp()-interval '30 seconds' and j.verified_at<=clock_timestamp()+interval '5 seconds'
        and j.verified_status='running' and j.verified_boot_id is not null and j.cancelled_at is null
        and j.dispatch_intent_at is not null and j.action_receipt->>'status'='success'
        and (p_kind='start' or j.verified_boot_id is distinct from j.before_boot_id));
  return found;
end;
$$;
revoke all on function public.complete_hivra_provider_desktop_power(text,uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.complete_hivra_provider_desktop_power(text,uuid,uuid,text,text,text) to service_role;
