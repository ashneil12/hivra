-- Settle only a matching claimed Start with confirmed stopped evidence.
-- A missing or ambiguous adapter outcome must leave the original claim held.
create function public.reject_hivra_managed_gvisor_start(
  p_customer text,p_computer uuid,p_operation uuid,p_receipt jsonb
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
  if (agent.status='stopped' and binding.active_target_id=binding.target_id
      and binding.lifecycle_operation_id=p_operation and binding.lifecycle_action='start'
      and binding.running_receipt is not null
      and p_receipt=(binding.running_receipt || '{"state":"stopped"}'::jsonb)) is not true
  then return false; end if;
  if agent.operation_id is null and agent.desired_state='stopped' and binding.lifecycle_receipt=p_receipt
  then return true; end if;
  if (agent.operation_id=p_operation and agent.operation_kind='start' and agent.desired_state='running'
      and binding.lifecycle_receipt is null) is not true then return false; end if;
  update public.hivra_managed_gvisor_bindings set lifecycle_receipt=p_receipt where computer_id=p_computer;
  update public.hivra_agents set desired_state='stopped',operation_id=null,operation_kind=null,
    operation_started_at=null,operation_payload=null where id=p_computer;
  return true;
end $$;

revoke all on function public.reject_hivra_managed_gvisor_start(text,uuid,uuid,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.reject_hivra_managed_gvisor_start(text,uuid,uuid,jsonb) to service_role;
