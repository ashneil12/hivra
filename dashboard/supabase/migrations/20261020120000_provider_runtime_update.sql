-- Owner-triggered runtime update for a running agent on a My cloud computer
-- (a provider VM). The update runs detached inside the guest (an SSH session
-- to a provider computer is bounded to seconds), so it holds the computer's
-- operation lease from the owner's request until the agent poll observes the
-- guest's own outcome. These two functions are its only claim and release.
--
-- Only the original, successfully installed agent on its still-bound
-- connection, order and target can be claimed, exactly as provider power
-- claims it. Provider desktops and DeepSeek computers are not claimable: their
-- runtime probes are bound to the release they were installed from.

alter table public.hivra_agents drop constraint if exists hivra_agents_operation_shape_check;
alter table public.hivra_agents add constraint hivra_agents_operation_shape_check check (
  (operation_id is null and operation_kind is null and operation_started_at is null and operation_payload is null)
  or (operation_id is not null and operation_kind in
    ('provision','start','stop','restart','resize','snapshot','restore','delete','desktop_prepare','agent_attach',
     'private_access','agent_access_change','agent_detach','runtime_update')
    and operation_kind is not null and operation_started_at is not null
    and (operation_payload is null or jsonb_typeof(operation_payload)='object'))
);

create or replace function public.claim_hivra_provider_runtime_update(p_user_id text,p_agent_id uuid,p_operation_id uuid)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; original public.hivra_agents%rowtype;
begin
  if p_operation_id is null then return false; end if;
  select * into original from public.hivra_agents where id=p_agent_id and user_id=p_user_id and computer_substrate='provider-vm';
  if not found then return false; end if;
  -- Parent-first order, as provider power claims it.
  perform id from public.infrastructure_connections where id=original.infrastructure_connection_id
    and user_id=p_user_id and provider='hetzner-cloud' and status='ready'
    and revision=original.infrastructure_connection_revision for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=original.provider_capacity_order_id
    and user_id=p_user_id and active_connection_id=original.infrastructure_connection_id
    and connection_revision=original.infrastructure_connection_revision and provider_resource_id=original.provider_server_id
    and status='created_off' for update;
  if not found then return false; end if;
  perform id from public.deployment_targets where id=original.deployment_target_id and user_id=p_user_id
    and connection_id=original.infrastructure_connection_id and evidence_connection_revision=original.infrastructure_connection_revision
    and provider_capacity_order_id=original.provider_capacity_order_id and external_id=original.provider_server_id
    and provider_retired_at is null and status='ready' and isolation_class='provider-vm'
    and capabilities->'launchReady'='true'::jsonb for update;
  if not found then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.computer_substrate<>'provider-vm' or a.desired_state<>'running'
    or a.type not in ('claude-code','codex','aeon','openclaw','agent-zero')
    or row(a.infrastructure_connection_id,a.infrastructure_connection_revision,a.deployment_target_id,a.provider_capacity_order_id,a.provider_server_id)
      is distinct from row(original.infrastructure_connection_id,original.infrastructure_connection_revision,
        original.deployment_target_id,original.provider_capacity_order_id,original.provider_server_id)
    or a.provider_install_outcome is distinct from 'succeeded' or a.provider_install_stopped_at is null then return false; end if;
  -- A replayed claim of the same update is not a new grant.
  if a.operation_id is not null then return a.operation_id=p_operation_id and a.operation_kind='runtime_update'; end if;
  if a.status<>'running' then return false; end if;
  update public.hivra_agents set status='provisioning',operation_id=p_operation_id,operation_kind='runtime_update',
    operation_started_at=clock_timestamp(),operation_payload=null,error=null where id=a.id;
  return true;
end;
$$;

-- The guest restores the previous runtime itself when its update fails, so a
-- finished update always returns the computer to running; a failure keeps its
-- reason for the owner. An observation of a deleted or replaced operation
-- changes nothing.
create or replace function public.finish_hivra_provider_runtime_update(p_user_id text,p_agent_id uuid,p_operation_id uuid,
  p_outcome text,p_error text)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if p_operation_id is null or p_outcome is null or p_outcome not in ('succeeded','failed')
    or (p_outcome='failed' and (p_error is null or length(p_error) not between 1 and 500))
    or (p_outcome='succeeded' and p_error is not null) then return false; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id and computer_substrate='provider-vm'
    and operation_id=p_operation_id and operation_kind='runtime_update' for update;
  if not found or a.status<>'provisioning' then return false; end if;
  update public.hivra_agents set status='running',operation_id=null,operation_kind=null,operation_started_at=null,
    operation_payload=null,error=case when p_outcome='failed' then p_error else null end where id=a.id;
  return true;
end;
$$;

revoke all on function public.claim_hivra_provider_runtime_update(text,uuid,uuid) from public,anon,authenticated;
revoke all on function public.finish_hivra_provider_runtime_update(text,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_hivra_provider_runtime_update(text,uuid,uuid),
  public.finish_hivra_provider_runtime_update(text,uuid,uuid,text,text) to service_role;
