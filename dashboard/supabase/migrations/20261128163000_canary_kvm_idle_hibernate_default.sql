create or replace function public.reserve_canary_hivra_disk_sleep_launch(
  p_user_id text, p_request_id uuid, p_fingerprints jsonb, p_model_operation_id uuid,
  p_agent jsonb, p_selection jsonb, p_encrypted_key text, p_agent_limit integer,
  p_cpu_overcommit_ratio numeric default null, p_skip_sleep boolean default false
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare result jsonb;
begin
  if p_agent->>'deployment_mode' is distinct from 'hivra-managed'
    or p_agent->>'computer_substrate' is distinct from 'proxmox-kvm'
    or p_agent->>'seat_funding' is distinct from 'paid'
    or p_agent->>'managed_provisioner_channel' is distinct from 'canary'
  then return jsonb_build_object('status','invalid_request'); end if;
  result := public.reserve_hivra_launch_model_request_v3(
    p_user_id, p_request_id, p_fingerprints, p_model_operation_id, p_agent,
    p_selection, p_encrypted_key, p_agent_limit, p_cpu_overcommit_ratio, p_skip_sleep
  );
  if result->>'status' = 'reserved' then
    update public.hivra_agents set sleep_policy = 't3'
      where id = (result->>'agentId')::uuid and user_id = p_user_id
        and operation_id = (p_agent->>'operation_id')::uuid and operation_kind = 'provision'
        and status = 'provisioning' and deployment_mode = 'hivra-managed'
        and computer_substrate = 'proxmox-kvm' and seat_funding = 'paid'
        and type = 'codex' and managed_provisioner_channel = 'canary'
        and sleep_policy = 'off' and always_on is false;
    if not found then raise exception 'Canary launch sleep default was not persisted'; end if;
  end if;
  return result;
end;
$$;

revoke all on function public.reserve_canary_hivra_disk_sleep_launch(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)
  from public, anon, authenticated;
grant execute on function public.reserve_canary_hivra_disk_sleep_launch(text,uuid,jsonb,uuid,jsonb,jsonb,text,integer,numeric,boolean)
  to service_role;
