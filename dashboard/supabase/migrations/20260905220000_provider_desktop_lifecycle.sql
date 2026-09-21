-- Dedicated Ubuntu provider desktop dispatch and original-operation handoff.
-- This migration is staged; routes/readiness probes must be integrated before
-- applying it to Canary. No guest assets or previous release rows are changed.
create or replace function public.hivra_provider_install_identity_valid(p_identity jsonb,p_agent_id uuid,p_operation_id uuid)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select ((jsonb_typeof(p_identity)='object'
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
  ) is true) or public.hivra_provider_native_identity_valid(p_identity,p_agent_id,p_operation_id)
    or public.hivra_provider_desktop_identity_valid(p_identity,p_agent_id,p_operation_id);
$$;

create function public.hivra_provider_desktop_access_valid(p_access jsonb)
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

create function public.hivra_provider_desktop_access_matches(p_access jsonb,a public.hivra_agents)
returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (public.hivra_provider_desktop_access_valid(p_access) and a.computer_substrate='provider-vm'
    and ((p_access->>'mode'='cloudflare-named' and a.cf_hostname=p_access->>'hostname'
      and a.cf_tunnel_id::text=p_access->>'tunnelId'
      and (a.chat_url is null or a.chat_url='https://'||a.cf_hostname))
      or (p_access->>'mode'='direct-https' and public.hivra_provider_direct_access_valid(a)
        and a.chat_url='https://'||(p_access->>'hostname')))) is true;
$$;

alter table public.hivra_agents add column provider_install_desktop_access jsonb;
alter table public.hivra_agents add constraint hivra_provider_desktop_access_shape check (
  ((provider_install_identity->'version'='3'::jsonb) is true)=(provider_install_desktop_access is not null)
  and (provider_install_desktop_access is null or public.hivra_provider_desktop_access_valid(provider_install_desktop_access))
);


create function public.guard_hivra_provider_desktop_access()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.provider_install_identity->'version'='3'::jsonb and new.status='running' then
    if new.api_token is not null or new.chat_url is null or new.ip is null
      or new.chat_url is distinct from 'https://'||(new.provider_install_desktop_access->>'hostname')
      or not public.hivra_provider_desktop_identity_valid(
        new.provider_install_identity,new.id,new.allocation_operation_id)
      or not public.hivra_provider_desktop_access_matches(new.provider_install_desktop_access,new)
      or not exists(select 1 from public.infrastructure_capacity_orders o
        where o.id=new.provider_capacity_order_id and o.user_id=new.user_id
          and o.connection_id=new.infrastructure_connection_id
          and o.connection_revision=new.infrastructure_connection_revision
          and o.provider_resource_id=new.provider_server_id
          and o.provider_creation_receipt->>'serverId'=new.provider_server_id
          and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=new.ip) then
      raise exception 'Desktop running state requires canonical provider access' using errcode='55006';
    end if;
  end if;
  if tg_op='INSERT' then return new; end if;
  if old.provider_install_desktop_access is not null and new.provider_install_desktop_access is distinct from old.provider_install_desktop_access then
    raise exception 'Retain original desktop access binding' using errcode='55006'; end if;
  if new.provider_install_identity->'version'='3'::jsonb and
    (old.provider_install_identity is null or (old.operation_kind='provision' and old.operation_id=old.allocation_operation_id)) then
    if not public.hivra_provider_desktop_access_matches(new.provider_install_desktop_access,new) then
      raise exception 'Retain desktop access through original operation handoff' using errcode='55006'; end if;
    if old.provider_install_identity is null
      and row(new.cf_hostname,new.cf_tunnel_id,new.chat_url,new.ip) is distinct from row(old.cf_hostname,old.cf_tunnel_id,old.chat_url,old.ip) then
      raise exception 'Bind desktop access before dispatching' using errcode='55006'; end if;
    if old.provider_install_identity is not null and row(new.chat_url,new.ip) is distinct from row(old.chat_url,old.ip) then
      if new.provider_install_desktop_access->>'mode'<>'cloudflare-named'
        or new.status<>'running' or new.operation_id is not null or new.operation_kind is not null
        or new.chat_url is distinct from 'https://'||(new.provider_install_desktop_access->>'hostname') then
        raise exception 'Desktop address changes require canonical readiness handoff' using errcode='55006'; end if;
      if new.ip is distinct from old.ip and new.ip is not null and not exists(
        select 1 from public.infrastructure_capacity_orders o where o.id=old.provider_capacity_order_id and o.user_id=old.user_id
          and o.provider_resource_id=old.provider_server_id and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=new.ip) then
        raise exception 'Desktop readiness address differs from original provider receipt' using errcode='55006'; end if;
    end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_desktop_access_guard before insert or update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_desktop_access();

create or replace function public.begin_hivra_provider_install_bound(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_native_access jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; t public.deployment_targets%rowtype; native boolean;
begin
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or p_identity->'version' not in ('1'::jsonb,'2'::jsonb)
    or a.type='linux-desktop' or not public.hivra_provider_install_identity_valid(p_identity,p_agent_id,p_operation_id) then
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

create function public.begin_hivra_provider_desktop_install(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_identity jsonb,p_access jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; t public.deployment_targets%rowtype;
begin
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or not public.hivra_provider_desktop_identity_valid(p_identity,p_agent_id,p_operation_id) then
    return jsonb_build_object('outcome','rejected'); end if;
  if a.type is distinct from 'linux-desktop' or a.computer_profile is distinct from 'ubuntu-desktop'
    or not public.hivra_provider_desktop_access_matches(p_access,a) then
    return jsonb_build_object('outcome','rejected'); end if;
  if a.provider_install_identity is not null then
    if a.provider_install_identity is distinct from p_identity
      or a.provider_install_desktop_access is distinct from p_access then
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
    provider_install_dispatched_at=clock_timestamp(),provider_install_desktop_access=p_access where id=a.id;
  return jsonb_build_object('outcome','dispatch','dispatchBudgetMs',30000);
end;
$$;

create function public.guard_hivra_provider_desktop_lifecycle()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.provider_install_identity is not null and
    (((new.provider_install_identity->'version'='3'::jsonb) is distinct from (new.type='linux-desktop'))
      or (new.type='linux-desktop' and new.computer_profile is distinct from 'ubuntu-desktop')) then
    raise exception 'Desktop runtime requires its original cleanup obligation' using errcode='55006'; end if;
  if tg_op='INSERT' then return new; end if;
  if (old.type='linux-desktop' or new.type='linux-desktop')
    and (old.provider_install_identity is not null or new.provider_install_identity is not null)
    and row(new.type,new.computer_profile) is distinct from row(old.type,old.computer_profile) then
    raise exception 'Do not change desktop runtime while dispatching or observing' using errcode='55006'; end if;
  if old.provider_install_identity->'version' is distinct from '3'::jsonb then return new; end if;
  if row(new.type,new.computer_profile) is distinct from row(old.type,old.computer_profile) then
    raise exception 'Retain desktop runtime identity' using errcode='55006'; end if;
  if old.status is distinct from 'running' and new.status='running'
    and coalesce(old.operation_kind,'') not in ('start','restart')
    and exists(select 1 from public.hivra_provider_desktop_cleanup
      where agent_id=old.id and operation_id=old.allocation_operation_id) then
    raise exception 'Cancelled desktop installation cannot reuse cached success' using errcode='55006'; end if;
  if old.operation_kind='provision' and old.operation_id=old.allocation_operation_id
    and row(new.operation_id,new.operation_kind,new.status) is distinct from row(old.operation_id,old.operation_kind,old.status) then
    -- All recovery RPCs load the held original op in provisioning. Do not
    -- strand it in error/stopped with a short-lived proof that cannot renew.
    -- Release+optional error is atomic; metadata-only errors remain allowed.
    if new.operation_id is not null or new.operation_kind is not null
      or new.operation_started_at is not null or new.operation_payload is not null then
      raise exception 'Retain desktop provisioning state until atomic handoff' using errcode='55006'; end if;
    -- A combined stopped+release update cannot bypass committed evidence.
    if old.provider_install_stopped_at is null then
      raise exception 'Verify desktop installer termination before handoff' using errcode='55006'; end if;
    if new.status='running' and old.desired_state='running' and new.desired_state='running'
      and new.operation_id is null and new.operation_kind is null and old.provider_install_outcome='succeeded'
      and not exists(select 1 from public.hivra_provider_desktop_cleanup
        where agent_id=old.id and operation_id=old.operation_id) then
      return new; -- Readiness intentionally retains the owned desktop service.
    end if;
    -- A grant durably latches cancellation intent even if its response was
    -- lost or it expired. Do not race readiness against a stopping desktop app.
    if new.status='running' then
      raise exception 'Desktop cancellation prevents successful readiness' using errcode='55006'; end if;
    if not public.hivra_provider_desktop_cleanup_verified(old.user_id,old.id,old.operation_id,
      old.provider_install_identity,old.provider_install_outcome) then
      raise exception 'Verify fresh desktop cleanup before releasing the provision operation' using errcode='55006'; end if;
  end if;
  return new;
end;
$$;
create trigger hivra_agents_provider_desktop_lifecycle_guard before insert or update on public.hivra_agents
  for each row execute function public.guard_hivra_provider_desktop_lifecycle();

create or replace function public.record_hivra_provider_install_stopped(p_user_id text,p_agent_id uuid,p_operation_id uuid,p_receipt jsonb)
returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype;
begin
  if not (((jsonb_typeof(p_receipt)='object'
    and p_receipt-array['version','identity','state','stopped']='{}'::jsonb
    and p_receipt->'version'='1'::jsonb and p_receipt->'identity'->'version'='1'::jsonb
    and p_receipt->'stopped'='true'::jsonb and p_receipt->>'state' in ('cancelled','failed','succeeded')
    and public.hivra_provider_install_identity_valid(p_receipt->'identity',p_agent_id,p_operation_id)) is true)
    or public.hivra_provider_native_stopped_receipt_valid(p_receipt,p_agent_id,p_operation_id)
    or public.hivra_provider_desktop_stopped_receipt_valid(p_receipt,p_agent_id,p_operation_id)) then return false; end if;
  select * into a from public.hivra_agents where user_id=p_user_id and id=p_agent_id
    and computer_substrate='provider-vm' and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and status='provisioning' for update;
  if not found or a.provider_install_identity is distinct from p_receipt->'identity' then return false; end if;
  if a.provider_install_stopped_at is not null then return a.provider_install_outcome=p_receipt->>'state'; end if;
  update public.hivra_agents set provider_install_stopped_at=clock_timestamp(),provider_install_outcome=p_receipt->>'state' where id=a.id;
  return true; -- Installer outcome only, never native cleanup or operation release.
end;
$$;

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
    and provider_install_identity->'version' is distinct from '2'::jsonb
    and provider_install_identity->'version' is distinct from '3'::jsonb;
  v_updated:=found;
  return v_updated;
end;
$$;

create function public.complete_hivra_provider_desktop_running(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_chat_url text,p_ip text,p_provisioned_at timestamptz
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_updated boolean:=false;
begin
  update public.hivra_agents set status='running',chat_url=p_chat_url,ip=coalesce(p_ip,ip),api_token=null,
    provisioned_at=coalesce(provisioned_at,p_provisioned_at),error=null,
    operation_id=null,operation_kind=null,operation_started_at=null,operation_payload=null
  where id=p_agent_id and user_id=p_user_id and operation_id=p_operation_id
    and operation_kind='provision' and allocation_operation_id=p_operation_id
    and desired_state='running' and status='provisioning' and type='linux-desktop' and computer_profile='ubuntu-desktop'
    and computer_substrate='provider-vm'
    and public.hivra_provider_desktop_identity_valid(provider_install_identity,id,operation_id)
    and provider_install_stopped_at is not null and provider_install_outcome='succeeded'
    and provider_install_desktop_access is not null
    and p_chat_url is not null and p_chat_url='https://'||(provider_install_desktop_access->>'hostname')
    and p_ip is not null and p_provisioned_at is not null
    and public.hivra_provider_desktop_access_matches(provider_install_desktop_access,hivra_agents)
    and exists(select 1 from public.infrastructure_capacity_orders o
      where o.id=hivra_agents.provider_capacity_order_id and o.user_id=hivra_agents.user_id
        and o.provider_resource_id=hivra_agents.provider_server_id
        and o.provider_creation_receipt#>>'{primaryIpv4,ip}'=p_ip)
    and not exists(select 1 from public.hivra_provider_desktop_cleanup j
      where j.agent_id=hivra_agents.id and j.operation_id=hivra_agents.operation_id);
  v_updated:=found;
  return v_updated;
end;
$$;

revoke all on function public.hivra_provider_desktop_access_valid(jsonb) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_access_valid(jsonb) to service_role;
revoke all on function public.hivra_provider_desktop_access_matches(jsonb,public.hivra_agents) from public,anon,authenticated;
grant execute on function public.hivra_provider_desktop_access_matches(jsonb,public.hivra_agents) to service_role;
revoke all on function public.guard_hivra_provider_desktop_access() from public,anon,authenticated;
revoke all on function public.guard_hivra_provider_desktop_lifecycle() from public,anon,authenticated;
revoke all on function public.begin_hivra_provider_desktop_install(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.begin_hivra_provider_desktop_install(text,uuid,uuid,jsonb,jsonb) to service_role;
revoke all on function public.complete_hivra_provider_desktop_running(text,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.complete_hivra_provider_desktop_running(text,uuid,uuid,text,text,timestamptz) to service_role;
