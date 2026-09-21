-- Close the private native dispatch TOCTOU: the origin/tunnel checked by the
-- adapter must still match when SQL grants dispatch, and remain stable until
-- the original operation is handed off. No public catalog or guest-byte change.
create function public.hivra_provider_native_access_valid(p_access jsonb)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_access)='object' and p_access-array['mode','hostname','tunnelId']='{}'::jsonb
    and jsonb_typeof(p_access->'hostname')='string' and length(p_access->>'hostname')<=253
    and position('.' in p_access->>'hostname')>0
    and substring(p_access->>'hostname' from '[^.]+$') ~ '^[a-z]{2,63}$'
    and not exists(select 1 from regexp_split_to_table(p_access->>'hostname','\.') as label
      where label like 'xn--%' or label !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$')
    and ((p_access->>'mode'='cloudflare-named' and jsonb_typeof(p_access->'tunnelId')='string'
      and p_access->>'tunnelId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
      or (p_access->>'mode'='direct-https' and p_access->'tunnelId'='null'::jsonb
        and p_access->>'hostname' ~ '^([0-9]{1,3}-){3}[0-9]{1,3}\.sslip\.io$'))
  ) is true;
$$;
create function public.hivra_provider_native_access_matches(p_access jsonb,a public.hivra_agents)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (public.hivra_provider_native_access_valid(p_access) and a.computer_substrate='provider-vm'
    and ((p_access->>'mode'='cloudflare-named' and a.cf_hostname=p_access->>'hostname'
      and a.cf_tunnel_id::text=p_access->>'tunnelId'
      and (a.chat_url is null or a.chat_url='https://'||a.cf_hostname))
      or (p_access->>'mode'='direct-https' and public.hivra_provider_direct_access_valid(a)
        and a.chat_url='https://'||(p_access->>'hostname')))) is true;
$$;
alter table public.hivra_agents add column provider_install_native_access jsonb;
alter table public.hivra_agents add constraint hivra_provider_native_access_shape check (
  ((provider_install_identity->'version'='2'::jsonb) is true)=(provider_install_native_access is not null)
  and (provider_install_native_access is null or public.hivra_provider_native_access_valid(provider_install_native_access))
);

create function public.guard_hivra_provider_native_access()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op='INSERT' then return new; end if;
  if old.provider_install_native_access is not null and new.provider_install_native_access is distinct from old.provider_install_native_access then
    raise exception 'Retain original native access binding' using errcode='55006'; end if;
  if new.provider_install_identity->'version'='2'::jsonb and
    (old.provider_install_identity is null or (old.operation_kind='provision' and old.operation_id=old.allocation_operation_id)) then
    -- Canonical readiness may fill chat_url/ip for named access. A different
    -- origin, tunnel, direct IPv4 or mixed access lane is never a readiness write.
    if not public.hivra_provider_native_access_matches(new.provider_install_native_access,new) then
      raise exception 'Retain native access through original operation handoff' using errcode='55006'; end if;
    if old.provider_install_identity is null
      and row(new.cf_hostname,new.cf_tunnel_id,new.chat_url,new.ip) is distinct from row(old.cf_hostname,old.cf_tunnel_id,old.chat_url,old.ip) then
      raise exception 'Bind native access before dispatching' using errcode='55006'; end if;
    if old.provider_install_identity is not null and row(new.chat_url,new.ip) is distinct from row(old.chat_url,old.ip) then
      if new.provider_install_native_access->>'mode'<>'cloudflare-named'
        or new.status<>'running' or new.operation_id is not null or new.operation_kind is not null
        or new.chat_url is distinct from 'https://'||(new.provider_install_native_access->>'hostname') then
        raise exception 'Native address changes require canonical readiness handoff' using errcode='55006'; end if;
      if new.ip is distinct from old.ip and new.ip is not null and not exists(
        select 1 from public.infrastructure_capacity_orders o where o.id=old.provider_capacity_order_id and o.user_id=old.user_id
          and o.provider_resource_id=old.provider_server_id and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=new.ip) then
        raise exception 'Native readiness address differs from original provider receipt' using errcode='55006'; end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_native_access_guard before insert or update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_native_access();

-- Shared admission retains all historical v1 lease/target/one-use fences. The
-- old four-argument RPC is deliberately v1-only; native uses the explicit
-- expected-binding RPC, not a browser-selected host or a second lease.
create function public.begin_hivra_provider_install_bound(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_native_access jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; t public.deployment_targets%rowtype; native boolean;
begin
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or not public.hivra_provider_install_identity_valid(p_identity,p_agent_id,p_operation_id) then
    return jsonb_build_object('outcome','rejected'); end if;
  native := p_identity->'version'='2'::jsonb;
  if native then
    if a.type<>'deepseek-harness' or not public.hivra_provider_native_access_matches(p_native_access,a) then
      return jsonb_build_object('outcome','rejected'); end if;
  elsif p_native_access is not null or a.type='deepseek-harness' then
    return jsonb_build_object('outcome','rejected');
  end if;
  if a.provider_install_identity is not null then
    if a.provider_install_identity is distinct from p_identity
      or a.provider_install_native_access is distinct from p_native_access then
      return jsonb_build_object('outcome','rejected'); end if;
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
    provider_install_dispatched_at=clock_timestamp(),provider_install_native_access=p_native_access where id=a.id;
  return jsonb_build_object('outcome','dispatch','dispatchBudgetMs',30000);
end;
$$;
create or replace function public.begin_hivra_provider_install(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select public.begin_hivra_provider_install_bound(p_user_id,p_agent_id,p_operation_id,p_identity,null);
$$;
create function public.begin_hivra_provider_native_install(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_access jsonb)
returns jsonb language sql security invoker set search_path=public,pg_temp as $$
  select case when public.hivra_provider_native_identity_valid(p_identity,p_agent_id,p_operation_id)
    then public.begin_hivra_provider_install_bound(p_user_id,p_agent_id,p_operation_id,p_identity,p_access)
    else jsonb_build_object('outcome','rejected') end;
$$;

revoke all on function public.hivra_provider_native_access_valid(jsonb) from public,anon,authenticated;
revoke all on function public.hivra_provider_native_access_matches(jsonb,public.hivra_agents) from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_native_access() from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_install_bound(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_native_install(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.hivra_provider_native_access_valid(jsonb) to service_role;
grant execute on function public.hivra_provider_native_access_matches(jsonb,public.hivra_agents) to service_role;
grant execute on function public.begin_hivra_provider_install_bound(text,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.begin_hivra_provider_native_install(text,uuid,uuid,jsonb,jsonb) to service_role;
