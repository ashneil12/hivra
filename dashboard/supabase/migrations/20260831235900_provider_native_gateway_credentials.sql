-- Private native credential-isolation release admission. No catalog/runtime enablement.
-- Admit the credential-isolated native gateway revision; preserve old immutable bundles.
-- This does not enable a new catalog runtime or alter allocation/lease fences.
create or replace function public.admit_prepared_provider_computer(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,
  p_attempt_id uuid,p_server text,p_lease_id uuid,p_target_id uuid,p_receipt jsonb
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  o public.infrastructure_capacity_orders%rowtype;
  b public.infrastructure_first_boot_operations%rowtype;
  t public.deployment_targets%rowtype;
begin
  perform id from public.infrastructure_connections where id=p_connection_id
    and user_id=p_user_id and revision=p_revision and provider='hetzner-cloud' and status='ready' for update;
  if not found then return false; end if;
  select * into o from public.infrastructure_capacity_orders where id=p_order_id
    and user_id=p_user_id and connection_id=p_connection_id and active_connection_id=p_connection_id
    and connection_revision=p_revision and status='created_off' for update;
  if not found or o.provider_resource_id is distinct from p_server
    or o.provider_server_status is distinct from 'accepted' or o.provider_ssh_key_status is distinct from 'accepted'
    or o.provider_creation_receipt->>'serverId' is distinct from p_server then return false; end if;
  perform attempt_id from public.infrastructure_first_boot_enrollments where attempt_id=p_attempt_id
    and order_id=p_order_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and provider_server_id=p_server and phase='enrolled'
    and enrolled_at>=issued_at and enrolled_at<expires_at for update;
  if not found then return false; end if;
  select * into b from public.infrastructure_first_boot_operations where order_id=p_order_id
    and attempt_id=p_attempt_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and provider_server_id=p_server for update;
  if not found or p_lease_id is null or b.lease_id is distinct from p_lease_id
    or b.lease_expires_at is null or b.lease_expires_at<=clock_timestamp() or b.abandoned_at is not null
    or b.firewall_receipt is null or b.firewall_verified_at is null
    or b.power_on_post_attempted_at is null or b.power_on_action->>'status' is distinct from 'success'
    or exists(select 1 from public.hivra_agents where provider_capacity_order_id=p_order_id)
    then return false; end if;
  select * into t from public.deployment_targets where id=p_target_id and user_id=p_user_id
    and connection_id=p_connection_id and evidence_connection_revision=p_revision
    and provider_capacity_order_id=p_order_id and external_id=p_server for update;
  if not found or t.provider_retired_at is not null or t.last_preflight_at is null
    or t.last_preflight_at<clock_timestamp()-interval '30 seconds' or t.last_preflight_at>clock_timestamp()+interval '5 seconds'
    or t.capabilities->>'enrollmentAttemptId' is distinct from p_attempt_id::text
    or t.capabilities->'runtimeCompatibility' is distinct from 'null'::jsonb
    or not coalesce(t.capabilities @> '{"kind":"provider-vm","provider":"hetzner-cloud","allocation":"exclusive-computer","provisioner":{"configured":true,"ready":true}}'::jsonb,false)
    or not coalesce(t.capabilities#>>'{provisioner,version}' in ('2026.08.28.1','2026.08.28.2','2026.08.28.3','2026.08.28.4','2026.08.29.1','2026.08.29.2','2026.08.29.3','2026.08.29.4','2026.08.29.5','2026.08.30.1','2026.08.30.2','2026.08.31.1','2026.08.31.2','2026.08.31.3','2026.08.31.4'),false)
    or t.isolation_class is distinct from 'provider-vm'
    or t.supported_isolation_drivers is distinct from array['provider-vm']::text[]
    or p_receipt is distinct from jsonb_build_object('version',1,'state','bundle_installed',
      'provisionerVersion',t.capabilities#>>'{provisioner,version}',
      'bundleSha256',t.capabilities#>>'{provisioner,bundleSha256}',
      'scopeSha256',t.capabilities#>>'{provisioner,scopeSha256}')
    then return false; end if;
  if t.status='ready' and t.capabilities->'launchReady'='true'::jsonb and t.last_error_code is null then return true; end if;
  if t.status<>'unavailable' or t.capabilities->'launchReady' is distinct from 'false'::jsonb
    or t.last_error_code is distinct from 'PROVIDER_ADAPTER_UNAVAILABLE' then return false; end if;
  update public.deployment_targets set status='ready',capabilities=jsonb_set(capabilities,'{launchReady}','true'),
    last_error_code=null,updated_at=clock_timestamp() where id=t.id;
  return true;
end;
$$;
revoke all on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb) to service_role;

-- Private DeepSeek v2 operation fencing. No catalog/route admission, provider
-- mutation or whole-VM fallback. v1 retains its historical installer semantics.
create or replace function public.hivra_provider_native_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle','nativeCleanup']='{}'::jsonb
    and p_identity->'version'='2'::jsonb
    and p_identity->>'agentId'=p_agent_id::text and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and ((p_identity->'bundle'->>'bundleSha256'='8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec' and p_identity->'bundle'->>'provisionerVersion'='2026.08.31.3')
      or (p_identity->'bundle'->>'bundleSha256'='bb67d66049af310db6f91b9627bd6e0bc25543e9629c9fc264d816b7ffb7b3aa' and p_identity->'bundle'->>'provisionerVersion'='2026.08.31.4'))
    and jsonb_typeof(p_identity->'nativeCleanup')='object'
    and (p_identity->'nativeCleanup')-array['profile','closureSha256']='{}'::jsonb
    and p_identity->'nativeCleanup'->>'profile'='deepseek-owned-service-v1'
    and p_identity->'nativeCleanup'->>'closureSha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'
  ) is true;
$$;

-- Native public access uses an opaque in-guest browser session, never the
-- legacy database management bearer. Allow a staged/legacy private row to be
-- inspected, but make a running native row with that credential impossible.
update public.hivra_agents set api_token=null
where provider_install_identity->'version'='2'::jsonb and status='running' and api_token is not null;
alter table public.hivra_agents add constraint hivra_provider_native_running_no_api_token check (
  not (provider_install_identity->'version'='2'::jsonb and status='running') or (
    api_token is null and chat_url is not null and ip is not null
    and chat_url='https://'||(provider_install_native_access->>'hostname')
    and public.hivra_provider_native_access_matches(provider_install_native_access,hivra_agents)
  )
);

-- Recheck the complete native authority chain on every row that is or becomes
-- running. This closes direct SQL and legacy-RPC paths even when the staged
-- URL/IP were null and therefore did not look like an address change to the
-- original access-binding trigger.
create or replace function public.guard_hivra_provider_native_access()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.provider_install_identity->'version'='2'::jsonb and new.status='running' then
    if new.api_token is not null or new.chat_url is null or new.ip is null
      or new.chat_url is distinct from 'https://'||(new.provider_install_native_access->>'hostname')
      or not public.hivra_provider_native_identity_valid(
        new.provider_install_identity,new.id,new.allocation_operation_id)
      or not public.hivra_provider_native_access_matches(new.provider_install_native_access,new)
      or not exists(select 1 from public.infrastructure_capacity_orders o
        where o.id=new.provider_capacity_order_id and o.user_id=new.user_id
          and o.connection_id=new.infrastructure_connection_id
          and o.connection_revision=new.infrastructure_connection_revision
          and o.provider_resource_id=new.provider_server_id
          and o.provider_creation_receipt->>'serverId'=new.provider_server_id
          and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=new.ip) then
      raise exception 'Native running state requires canonical provider access' using errcode='55006';
    end if;
  end if;
  if tg_op='INSERT' then return new; end if;
  if old.provider_install_native_access is not null and new.provider_install_native_access is distinct from old.provider_install_native_access then
    raise exception 'Retain original native access binding' using errcode='55006'; end if;
  if new.provider_install_identity->'version'='2'::jsonb and
    (old.provider_install_identity is null or (old.operation_kind='provision' and old.operation_id=old.allocation_operation_id)) then
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

-- Preserve the shared v1 NULL=preserve-token contract, but make it explicitly
-- reject v2. Native readiness owns the only v2 terminal CAS below.
create or replace function public.complete_hivra_agent_running(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_operation_kind text,
  p_chat_url text,p_ip text,p_api_token text,p_provisioned_at timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_updated boolean:=false;
begin
  if p_operation_kind not in ('provision','start','restart','resize') then
    raise exception 'invalid running convergence operation' using errcode='22023';
  end if;
  update public.hivra_agents set status='running',chat_url=p_chat_url,ip=coalesce(p_ip,ip),
    api_token=coalesce(p_api_token,api_token),provisioned_at=coalesce(provisioned_at,p_provisioned_at),error=null,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
  where id=p_agent_id and user_id=p_user_id and operation_id=p_operation_id
    and operation_kind=p_operation_kind and desired_state='running' and status='provisioning'
    and provider_install_identity->'version' is distinct from '2'::jsonb;
  v_updated:=found;
  return v_updated;
end;
$$;

-- Native readiness has its own narrow terminal CAS and explicitly clears any
-- staged legacy token in the same statement that publishes running.
create function public.complete_hivra_provider_native_running(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_chat_url text,p_ip text,p_provisioned_at timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_updated boolean:=false;
begin
  update public.hivra_agents set status='running',chat_url=p_chat_url,ip=coalesce(p_ip,ip),api_token=null,
    provisioned_at=coalesce(provisioned_at,p_provisioned_at),error=null,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
  where id=p_agent_id and user_id=p_user_id and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and desired_state='running' and status='provisioning' and type='deepseek-harness'
    and computer_substrate='provider-vm'
    and public.hivra_provider_native_identity_valid(provider_install_identity,id,operation_id)
    and provider_install_stopped_at is not null and provider_install_outcome='succeeded'
    and provider_install_native_access is not null
    and p_chat_url is not null and p_chat_url='https://'||(provider_install_native_access->>'hostname')
    and p_ip is not null and p_provisioned_at is not null
    and public.hivra_provider_native_access_matches(provider_install_native_access,hivra_agents)
    and exists(select 1 from public.infrastructure_capacity_orders o
      where o.id=hivra_agents.provider_capacity_order_id and o.user_id=hivra_agents.user_id
        and o.provider_resource_id=hivra_agents.provider_server_id
        and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=p_ip)
    and not exists(select 1 from public.hivra_provider_native_cleanup j
      where j.agent_id=hivra_agents.id and j.operation_id=hivra_agents.operation_id);
  v_updated:=found;
  return v_updated;
end;
$$;

revoke all on function public.complete_hivra_provider_native_running(text,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_hivra_provider_native_running(text,uuid,uuid,text,text,timestamptz) to service_role;
