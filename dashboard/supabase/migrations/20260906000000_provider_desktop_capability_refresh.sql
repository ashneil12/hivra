-- Stable provider desktop observation uses the existing session/capability
-- ledger. Lock the original computer before its shared capability write so a
-- concurrent lifecycle or binding change cannot publish stale running evidence.
create function public.record_hivra_provider_desktop_capability(
  p_user_id text,p_agent_id uuid,p_identity jsonb,p_access jsonb,p_ip text,
  p_target_id uuid,p_receipt jsonb,p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and computer_substrate='provider-vm' and deployment_mode='self-managed'
    and type='linux-desktop' and computer_profile='ubuntu-desktop'
    and status='running' and desired_state='running' and operation_id is null and operation_kind is null for update;
  if not found or a.vmid is not null or a.provider_install_outcome is distinct from 'succeeded'
    or a.provider_install_stopped_at is null or a.api_token is not null
    or a.provider_install_identity is distinct from p_identity
    or not public.hivra_provider_desktop_identity_valid(p_identity,a.id,a.allocation_operation_id)
    or a.provider_install_desktop_access is distinct from p_access
    or not public.hivra_provider_desktop_access_matches(p_access,a)
    or a.ip is distinct from p_ip or a.deployment_target_id is distinct from p_target_id
    or a.chat_url is distinct from ('https://'||(p_access->>'hostname'))
    or p_receipt->>'brokerOrigin' is distinct from a.chat_url
    or p_receipt->>'computerId' is distinct from a.id::text
    or p_receipt->>'computerKind' is distinct from 'hivra-agent'
    then return jsonb_build_object('status','computer_not_ready'); end if;
  return public.record_hivra_remote_desktop_capability(p_user_id,'hivra-agent',p_agent_id,
    (p_receipt->>'capabilityGeneration')::uuid,p_receipt,p_expires_at);
end;
$$;
revoke all on function public.record_hivra_provider_desktop_capability(text,uuid,jsonb,jsonb,text,uuid,jsonb,timestamptz)
  from public,anon,authenticated;
grant execute on function public.record_hivra_provider_desktop_capability(text,uuid,jsonb,jsonb,text,uuid,jsonb,timestamptz)
  to service_role;
