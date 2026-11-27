create or replace function public.claim_hivra_agent_idle_sleep(
  p_agent_id uuid, p_operation_id uuid, p_tier text, p_expected_generation bigint
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare allowed boolean;
begin
  select a.always_on is false and case p_tier
    when 'nap' then a.sleep_policy in ('t1', 'full')
    when 'hibernate' then a.sleep_policy in ('t3', 'full')
    else false
  end into allowed
  from public.hivra_agents a where a.id = p_agent_id for update;
  if allowed is distinct from true then return null; end if;
  return public.claim_hivra_agent_sleep(p_agent_id, p_operation_id, p_tier, p_expected_generation);
end;
$$;

revoke all on function public.claim_hivra_agent_idle_sleep(uuid, uuid, text, bigint) from public, anon, authenticated;
grant execute on function public.claim_hivra_agent_idle_sleep(uuid, uuid, text, bigint) to service_role;
