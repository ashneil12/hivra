create table public.hivra_managed_gvisor_command_activity (
  computer_id uuid primary key references public.hivra_agents(id) on delete cascade,
  last_activity_at timestamptz not null default clock_timestamp(),
  command_claim_id uuid
);

alter table public.hivra_managed_gvisor_command_activity enable row level security;
revoke all on public.hivra_managed_gvisor_command_activity from public, anon, authenticated, service_role;

create function public.claim_hivra_managed_gvisor_pilot_command(
  p_customer text, p_computer uuid, p_expires_at timestamptz
) returns uuid language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  command_claim uuid;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  if (p_expires_at > clock_timestamp()) is not true then return null; end if;
  perform 1 from public.hivra_agents
    where id=p_computer and user_id=p_customer and deployment_mode='hivra-managed'
      and computer_substrate='gvisor' and type='linux-terminal' and computer_profile='linux-terminal'
      and status='running' and desired_state='running' and operation_id is null for update;
  if not found then return null; end if;

  insert into public.hivra_managed_gvisor_command_activity as activity(computer_id, command_claim_id)
    values(p_computer, gen_random_uuid())
    on conflict (computer_id) do update set command_claim_id=excluded.command_claim_id
      where activity.command_claim_id is null
    returning command_claim_id into command_claim;
  return command_claim;
end $$;

create function public.complete_hivra_managed_gvisor_pilot_command(
  p_customer text, p_computer uuid, p_claim uuid
) returns boolean language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  update public.hivra_managed_gvisor_command_activity as activity
    set last_activity_at=clock_timestamp(), command_claim_id=null
    from public.hivra_agents as agent
    where activity.computer_id=p_computer and activity.command_claim_id=p_claim
      and agent.id=activity.computer_id and agent.user_id=p_customer;
  return found;
end $$;

create function public.claim_hivra_managed_gvisor_pilot_idle_stop(
  p_customer text, p_operator text, p_connection uuid, p_target uuid, p_revision bigint, p_expires_at timestamptz
) returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  candidate uuid;
  cutoff timestamptz;
begin
  perform public.lock_hivra_owner_agent_slots(p_customer);
  if (p_expires_at > clock_timestamp()) is not true or p_customer=p_operator then return null; end if;
  cutoff := clock_timestamp() - interval '10 minutes';
  select agent.id into candidate
    from public.hivra_managed_gvisor_command_activity as activity
    join public.hivra_agents as agent on agent.id=activity.computer_id
    join public.hivra_managed_gvisor_bindings as binding on binding.computer_id=agent.id and binding.customer_id=agent.user_id
    where agent.user_id=p_customer and agent.deployment_mode='hivra-managed'
      and agent.computer_substrate='gvisor' and agent.type='linux-terminal' and agent.computer_profile='linux-terminal'
      and agent.status='running' and agent.desired_state='running' and agent.operation_id is null
      and binding.operator_id=p_operator and binding.connection_id=p_connection
      and binding.active_target_id=p_target and binding.target_id=p_target and binding.connection_revision=p_revision
      and activity.last_activity_at<=cutoff and activity.command_claim_id is null
      and not exists(select 1 from public.hivra_agent_events as event
        where event.agent_id=agent.id and event.user_id=p_customer and event.event='started' and event.created_at>cutoff)
    order by activity.last_activity_at, agent.id limit 1 for update of agent;
  if not found then return null; end if;
  return public.claim_hivra_managed_gvisor_lifecycle(p_customer,candidate,'stop');
end $$;

revoke all on function public.claim_hivra_managed_gvisor_pilot_command(text,uuid,timestamptz),
  public.complete_hivra_managed_gvisor_pilot_command(text,uuid,uuid),
  public.claim_hivra_managed_gvisor_pilot_idle_stop(text,text,uuid,uuid,bigint,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.claim_hivra_managed_gvisor_pilot_command(text,uuid,timestamptz),
  public.complete_hivra_managed_gvisor_pilot_command(text,uuid,uuid),
  public.claim_hivra_managed_gvisor_pilot_idle_stop(text,text,uuid,uuid,bigint,timestamptz) to service_role;
