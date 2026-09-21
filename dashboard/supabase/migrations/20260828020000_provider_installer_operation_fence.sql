-- The private guest worker belongs to the existing agent provision operation.
-- No new lease, public launch caller, provider purchase or target publication.
alter table public.hivra_agents
  add column provider_install_not_after timestamptz,
  add column provider_install_identity jsonb,
  add column provider_install_dispatched_at timestamptz,
  add column provider_install_stopped_at timestamptz,
  add column provider_install_outcome text,
  add constraint hivra_agents_provider_install_shape_check check ((
    (provider_install_identity is null and provider_install_dispatched_at is null
      and provider_install_stopped_at is null and provider_install_outcome is null)
    or (computer_substrate='provider-vm' and provider_install_identity is not null
      and provider_install_dispatched_at is not null
      and ((provider_install_stopped_at is null and provider_install_outcome is null)
        or (provider_install_stopped_at>=provider_install_dispatched_at
          and provider_install_outcome in ('cancelled','failed','succeeded'))))
  ) is true);

create function public.hivra_provider_install_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle']='{}'::jsonb
    and p_identity->'version'='1'::jsonb
    and p_identity->>'agentId'=p_agent_id::text
    and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb
    and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p_identity->'bundle'->'bundleSha256')='string'
    and p_identity->'bundle'->>'bundleSha256' ~ '^[0-9a-f]{64}$'
    and jsonb_typeof(p_identity->'bundle'->'provisionerVersion')='string'
    and p_identity->'bundle'->>'provisionerVersion' ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[1-9][0-9]{0,3}$'
  ) is true;
$$;

create function public.guard_hivra_provider_installer()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then
    if new.provider_install_identity is not null then
      raise exception 'Reserve the computer before dispatching its installer' using errcode='55006'; end if;
    new.provider_install_not_after := case when new.computer_substrate='provider-vm'
      then new.operation_started_at+interval '45 seconds' else null end;
    return new;
  end if;
  if new.provider_install_not_after is distinct from old.provider_install_not_after then
    raise exception 'Do not renew the original installer admission window' using errcode='55006'; end if;
  if old.provider_install_identity is null and new.provider_install_identity is not null then
    if old.computer_substrate<>'provider-vm' or old.operation_kind is distinct from 'provision'
      or old.operation_id is distinct from old.allocation_operation_id
      or old.status is distinct from 'provisioning' or old.desired_state is distinct from 'running'
      or old.provider_install_not_after is null or clock_timestamp()>=old.provider_install_not_after
      or old.operation_started_at is distinct from old.provider_install_not_after-interval '45 seconds'
      or old.operation_started_at>clock_timestamp()
      or row(new.operation_id,new.operation_kind,new.operation_started_at,new.desired_state,new.status)
        is distinct from row(old.operation_id,old.operation_kind,old.operation_started_at,old.desired_state,old.status)
      or not public.hivra_provider_install_identity_valid(new.provider_install_identity,old.id,old.operation_id)
      or new.provider_install_dispatched_at is null
      or new.provider_install_dispatched_at<clock_timestamp()-interval '5 seconds'
      or new.provider_install_dispatched_at>clock_timestamp()
      or new.provider_install_stopped_at is not null or new.provider_install_outcome is not null then
      raise exception 'Provider installer dispatch lacks original operation authority' using errcode='55006'; end if;
  elsif old.provider_install_identity is not null then
    if row(new.provider_install_identity,new.provider_install_dispatched_at)
      is distinct from row(old.provider_install_identity,old.provider_install_dispatched_at) then
      raise exception 'Retain original provider installer identity' using errcode='55006'; end if;
    if old.provider_install_stopped_at is null then
      -- Applies to normal completion, recovery, delete and old direct writers.
      -- A stopped receipt must be committed before another operation can own
      -- this computer. A request to delete may still change desired_state.
      if row(new.operation_id,new.operation_kind,new.status)
        is distinct from row(old.operation_id,old.operation_kind,old.status) then
        raise exception 'Verify installer termination before releasing the operation' using errcode='55006'; end if;
    elsif row(new.provider_install_stopped_at,new.provider_install_outcome)
      is distinct from row(old.provider_install_stopped_at,old.provider_install_outcome) then
      raise exception 'Retain original provider installer termination evidence' using errcode='55006'; end if;
  end if;
  if old.computer_substrate='provider-vm' and old.status is distinct from 'running'
    and new.status='running' and (old.provider_install_stopped_at is null
      or old.provider_install_outcome is distinct from 'succeeded') then
    raise exception 'A running provider computer requires its successful stopped installer' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_installer_guard before insert or update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_installer();

create function public.begin_hivra_provider_install(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; t public.deployment_targets%rowtype;
begin
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or not public.hivra_provider_install_identity_valid(p_identity,p_agent_id,p_operation_id) then
    return jsonb_build_object('outcome','rejected'); end if;
  if a.provider_install_identity is not null then
    if a.provider_install_identity is distinct from p_identity then
      return jsonb_build_object('outcome','rejected'); end if;
    -- Even a lost first acknowledgement is observation-only, never a new
    -- dispatch grant. Recovery cannot refresh the original start window.
    return jsonb_build_object('outcome','observe');
  end if;
  if a.desired_state<>'running' or a.provider_install_not_after is null
    or clock_timestamp()>=a.provider_install_not_after
    or a.operation_started_at is distinct from a.provider_install_not_after-interval '45 seconds'
    or a.operation_started_at>clock_timestamp() then return jsonb_build_object('outcome','rejected'); end if;
  select * into t from public.deployment_targets where id=a.deployment_target_id
    and user_id=a.user_id and connection_id=a.infrastructure_connection_id
    and evidence_connection_revision=a.infrastructure_connection_revision
    and provider_capacity_order_id=a.provider_capacity_order_id and external_id=a.provider_server_id
    and provider_retired_at is null and status='ready'
    and capabilities->'launchReady'='true'::jsonb
    and capabilities->'provisioner'->'configured'='true'::jsonb
    and capabilities->'provisioner'->'ready'='true'::jsonb;
  if not found or t.capabilities->'provisioner'->>'version' is distinct from p_identity->'bundle'->>'provisionerVersion'
    or t.capabilities->'provisioner'->>'bundleSha256' is distinct from p_identity->'bundle'->>'bundleSha256'
    or t.capabilities->'provisioner'->>'scopeSha256' is distinct from p_identity->'bundle'->>'scopeSha256' then
    return jsonb_build_object('outcome','rejected'); end if;
  update public.hivra_agents set provider_install_identity=p_identity,
    provider_install_dispatched_at=clock_timestamp() where id=a.id;
  -- Caller starts its monotonic 30s fence BEFORE this RPC. Together with the
  -- 45s admission, 20s guest start fence, 8min worker and 5s stop cap this ends
  -- before the original 10min recovery window. No fresh clock renews it.
  return jsonb_build_object('outcome','dispatch','dispatchBudgetMs',30000);
end;
$$;

create function public.record_hivra_provider_install_stopped(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if (jsonb_typeof(p_receipt)='object'
    and p_receipt-array['version','identity','state','stopped']='{}'::jsonb
    and p_receipt->'version'='1'::jsonb and p_receipt->'stopped'='true'::jsonb
    and p_receipt->>'state' in ('cancelled','failed','succeeded')
    and public.hivra_provider_install_identity_valid(p_receipt->'identity',p_agent_id,p_operation_id)) is not true then
    return false; end if;
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or a.provider_install_identity is distinct from p_receipt->'identity' then return false; end if;
  if a.provider_install_stopped_at is not null then
    return a.provider_install_outcome=p_receipt->>'state'; end if;
  update public.hivra_agents set provider_install_stopped_at=clock_timestamp(),
    provider_install_outcome=p_receipt->>'state' where id=a.id;
  -- This records a server-verified worker receipt, not readiness, rollback,
  -- operation release or provider cleanup. Those remain separate checks.
  return true;
end;
$$;

revoke all on function public.hivra_provider_install_identity_valid(jsonb,uuid,uuid) from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_installer() from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_install(text,uuid,uuid,jsonb) from public,anon,authenticated;
revoke all on function public.record_hivra_provider_install_stopped(text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.hivra_provider_install_identity_valid(jsonb,uuid,uuid) to service_role;
grant execute on function public.begin_hivra_provider_install(text,uuid,uuid,jsonb) to service_role;
grant execute on function public.record_hivra_provider_install_stopped(text,uuid,uuid,jsonb) to service_role;
