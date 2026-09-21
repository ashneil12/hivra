-- Standalone provider computers own their public HTTPS endpoint. Bind the
-- exact provider-verified IPv4 to the original reserved operation before any
-- guest mutation; hosted named-tunnel fields remain a mutually exclusive lane.
create or replace function public.bind_hivra_provider_direct_access(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_address text
) returns boolean language plpgsql security invoker set search_path=public,pg_temp as $$
declare a public.hivra_agents%rowtype; v_ip inet; v_hostname text; v_origin text;
begin
  begin v_ip:=p_address::inet; exception when others then return false; end;
  if family(v_ip) is distinct from 4 or host(v_ip) is distinct from p_address
    or v_ip << inet '0.0.0.0/8' or v_ip << inet '10.0.0.0/8'
    or v_ip << inet '100.64.0.0/10' or v_ip << inet '127.0.0.0/8'
    or v_ip << inet '169.254.0.0/16' or v_ip << inet '172.16.0.0/12'
    or v_ip << inet '192.168.0.0/16' then return false; end if;
  v_hostname:=replace(p_address,'.','-')||'.sslip.io';
  v_origin:='https://'||v_hostname;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id
    and operation_id=p_operation_id and allocation_operation_id=p_operation_id
    and operation_kind='provision' and status='provisioning' and desired_state='running'
    and computer_substrate='provider-vm' for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=a.provider_capacity_order_id
    and user_id=a.user_id and connection_id=a.infrastructure_connection_id
    and active_connection_id=a.infrastructure_connection_id
    and connection_revision=a.infrastructure_connection_revision
    and provider_resource_id=a.provider_server_id and provider_server_status='accepted'
    and provider_creation_receipt->>'serverId'=a.provider_server_id
    and provider_creation_receipt#>>'{primaryIpv4,ip}'=p_address for key share;
  if not found then return false; end if;
  if a.chat_url is not null or a.ip is not null or a.cf_tunnel_id is not null or a.cf_hostname is not null then
    return a.chat_url is not distinct from v_origin and a.ip is not distinct from p_address
      and a.cf_tunnel_id is null and a.cf_hostname is null;
  end if;
  update public.hivra_agents set chat_url=v_origin,ip=p_address where id=a.id;
  return true;
end;
$$;
revoke all on function public.bind_hivra_provider_direct_access(text,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.bind_hivra_provider_direct_access(text,uuid,uuid,text) to service_role;

-- Admit the exact new bundle while preserving every previously admitted
-- immutable provider-computer release for recovery and lifecycle operations.
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
    or not coalesce(t.capabilities#>>'{provisioner,version}' in ('2026.08.28.1','2026.08.28.2','2026.08.28.3','2026.08.28.4','2026.08.29.1','2026.08.29.2','2026.08.29.3','2026.08.29.4','2026.08.29.5','2026.08.30.1','2026.08.30.2'),false)
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

create or replace function public.hivra_provider_direct_access_valid(a public.hivra_agents)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,pg_temp as $$
declare v_ip inet;
begin
  if a.computer_substrate is distinct from 'provider-vm' or a.cf_hostname is not null or a.cf_tunnel_id is not null
    or a.ip is null or a.chat_url is null then return false; end if;
  begin v_ip:=a.ip::inet; exception when others then return false; end;
  return family(v_ip)=4 and host(v_ip)=a.ip
    and not (v_ip << inet '0.0.0.0/8' or v_ip << inet '10.0.0.0/8'
      or v_ip << inet '100.64.0.0/10' or v_ip << inet '127.0.0.0/8'
      or v_ip << inet '169.254.0.0/16' or v_ip << inet '172.16.0.0/12'
      or v_ip << inet '192.168.0.0/16')
    and a.chat_url='https://'||replace(a.ip,'.','-')||'.sslip.io';
end;
$$;

create or replace function public.hivra_model_key_binding(a public.hivra_agents)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select jsonb_build_object('agentId',a.id,'userId',a.user_id,'runtime',a.type,
    'deploymentMode',a.deployment_mode,'substrate',a.computer_substrate,
    'allocationId',a.allocation_operation_id,'host',a.proxmox_host,'vmid',a.vmid,
    'connectionId',a.infrastructure_connection_id,
    'targetId',a.deployment_target_id,'orderId',a.provider_capacity_order_id,
    'enrollmentId',a.provider_enrollment_attempt_id,'serverId',a.provider_server_id,
    'hostname',case when public.hivra_provider_direct_access_valid(a) then replace(a.ip,'.','-')||'.sslip.io' else a.cf_hostname end,
    'tunnelId',a.cf_tunnel_id,'chatUrl',a.chat_url,
    'tokenDigest',encode(sha256(convert_to(a.api_token,'UTF8')),'hex'));
$$;

create or replace function public.admit_hivra_model_key_operation(
  p_user_id text,p_agent_id uuid,p_operation_id uuid,p_binding jsonb,p_request jsonb
) returns text language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare
  a public.hivra_agents%rowtype;
  j public.hivra_model_key_operations%rowtype;
  c jsonb; payload jsonb; receipt jsonb; candidate jsonb; cipher text; key_id uuid;
begin
  if p_operation_id is null or jsonb_typeof(p_request) is distinct from 'object'
    or octet_length(p_request::text)>8192 then return 'invalid_request'; end if;
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found then return 'not_found'; end if;
  if public.hivra_model_key_binding(a) is distinct from p_binding then return 'target_changed'; end if;
  select * into j from public.hivra_model_key_operations where operation_id=p_operation_id;
  if found then
    if j.agent_id=a.id and j.user_id=a.user_id and j.binding=p_binding
      and j.request_digest=p_request->>'requestDigest' then return j.phase; end if;
    return 'operation_conflict';
  end if;
  if a.type<>'codex' or a.status<>'running' or a.desired_state<>'running' or a.operation_id is not null
    or a.api_token !~ '^[a-f0-9]{64}$' or a.api_token is null
    or ((a.cf_hostname is not null and a.cf_tunnel_id is not null
      and a.chat_url='https://' || a.cf_hostname) or public.hivra_provider_direct_access_valid(a)) is not true
    or (a.computer_substrate='proxmox-kvm' and a.vmid is null)
    then return 'not_ready'; end if;
  if exists(select 1 from public.hivra_model_key_operations where agent_id=a.id and phase='pending')
    then return 'pending_conflict'; end if;
  c := nullif(p_request->'config','null'::jsonb);
  payload := nullif(p_request->'payload','null'::jsonb);
  candidate := nullif(p_request->'managedKey','null'::jsonb);
  cipher := p_request->>'encryptedKey';
  receipt := p_request->'expectedReceipt';
  if (p_request=jsonb_build_object('requestDigest',p_request->'requestDigest',
      'config',c,'payload',payload,'managedKey',candidate,'encryptedKey',cipher,
      'expectedStateDigest',p_request->'expectedStateDigest','expectedReceipt',receipt)
    and p_request->>'requestDigest' ~ '^[a-f0-9]{64}$'
    and p_request->>'expectedStateDigest' ~ '^[a-f0-9]{64}$'
    and receipt=jsonb_build_object('protocol','hivra-llm-apply-v1','operationId',p_operation_id,
      'stateDigest',receipt->'stateDigest','payloadDigest',receipt->'payloadDigest',
      'provider',payload->'provider','model',payload->'model')
    and receipt->>'stateDigest' ~ '^[a-f0-9]{64}$'
    and receipt->>'payloadDigest' ~ '^[a-f0-9]{64}$') is not true
    then return 'invalid_request'; end if;
  if c is null then
    if payload is not null or candidate is not null or cipher is not null then return 'invalid_request'; end if;
  else
    if (c->>'provider'='venice' and c->>'mode' in ('byok','managed')
      and c->>'model' ~ '^[A-Za-z0-9._:/\[\]-]{1,64}$'
      and cipher ~ '^[A-Za-z0-9+/]+={0,2}$' and length(cipher) between 48 and 384
      and payload=jsonb_build_object('provider','venice','baseUrl',payload->'baseUrl','model',c->'model')
      and payload->>'baseUrl' ~ '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._/-]*)?$') is not true
      then return 'invalid_request'; end if;
    if c->>'mode'='byok' then
      if c is distinct from jsonb_build_object('provider','venice','mode','byok','model',c->'model')
        or candidate is not null or payload->>'baseUrl' is distinct from 'https://api.venice.ai/api/v1'
        then return 'invalid_request'; end if;
    else
      if (candidate=jsonb_build_object('id',candidate->'id','accountId',candidate->'accountId',
          'hash',candidate->'hash','prefix',candidate->'prefix')
        and candidate->>'id' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        and candidate->>'accountId' ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'
        and candidate->>'hash' ~ '^[a-f0-9]{64}$' and candidate->>'prefix' ~ '^hven_live_[A-Za-z0-9_-]{1,16}$'
        and c=jsonb_build_object('provider','venice','mode','managed','model',c->'model',
          'proxyKeyId',candidate->'id','keyPrefix',candidate->'prefix','walletType',c->'walletType')
        and c->>'walletType' in ('card','hermesos')) is not true then return 'invalid_request'; end if;
      perform id from public.managed_venice_wallet_accounts
        where id=(candidate->>'accountId')::uuid and user_id=a.user_id for key share;
      if not found then return 'invalid_wallet'; end if;
      key_id := (candidate->>'id')::uuid;
    end if;
  end if;
  if a.llm_config is not null and (a.llm_config->>'provider'='venice'
    and a.llm_config->>'mode' in ('byok','managed')
    and (a.llm_config->>'mode'<>'managed' or a.llm_config->>'proxyKeyId' is not null)) is not true
    then return 'legacy_config_invalid'; end if;
  if a.llm_config->>'proxyKeyId' is not null then
    perform id from public.managed_venice_proxy_keys where id::text=a.llm_config->>'proxyKeyId'
      and user_id=a.user_id for update;
    if not found then return 'legacy_config_invalid'; end if;
  end if;
  if key_id is not null then
    insert into public.managed_venice_proxy_keys(id,account_id,user_id,name,key_hash,key_prefix,status,paused_reason,metadata)
      values(key_id,(candidate->>'accountId')::uuid,a.user_id,'Agent model key',candidate->>'hash',candidate->>'prefix',
        'paused','Awaiting agent application',jsonb_build_object('defaultWalletType',c->>'walletType'));
  end if;
  insert into public.hivra_model_key_operations(operation_id,agent_id,user_id,request_digest,binding,admission_connection_revision,
    previous_config,previous_cipher_digest,config,payload,encrypted_key,cipher_digest,expected_state_digest,expected_receipt,managed_key_id)
    values(p_operation_id,a.id,a.user_id,p_request->>'requestDigest',p_binding,a.infrastructure_connection_revision,a.llm_config,
      encode(sha256(convert_to(a.llm_api_key_encrypted,'UTF8')),'hex'),
      case when c is null then null else c || jsonb_build_object('enabledAt',clock_timestamp()) end,
      payload,cipher,encode(sha256(convert_to(cipher,'UTF8')),'hex'),p_request->>'expectedStateDigest',receipt,key_id);
  return 'pending';
end;
$$;

create or replace function public.claim_hivra_launch_model_attempt(p_user_id text,p_agent_id uuid,p_request_id uuid,p_automatic boolean)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare a public.hivra_agents%rowtype; q public.hivra_launch_model_requests%rowtype;
begin
  select * into a from public.hivra_agents where id=p_agent_id and user_id=p_user_id for update;
  if not found or a.type<>'codex' or a.status<>'running' or a.desired_state<>'running' or a.operation_id is not null
    then return null; end if;
  select * into q from public.hivra_launch_model_requests where user_id=p_user_id and agent_id=p_agent_id and request_id=p_request_id for update;
  if not found or q.phase<>'waiting' or q.binding is distinct from public.hivra_launch_model_binding(a)
    or a.allocation_operation_id is distinct from q.provision_operation_id
    or a.api_token is null or a.api_token !~ '^[a-f0-9]{64}$'
    or ((a.cf_hostname is not null and a.cf_tunnel_id is not null
      and a.chat_url='https://' || a.cf_hostname) or public.hivra_provider_direct_access_valid(a)) is not true
    or (a.computer_substrate='proxmox-kvm' and a.vmid is null)
    or p_automatic is null or (p_automatic and q.attempted_at is not null)
    or q.attempt_expires_at>clock_timestamp() then return null; end if;
  update public.hivra_launch_model_requests set attempted_at=coalesce(attempted_at,clock_timestamp()),
    attempt_id=gen_random_uuid(),attempt_expires_at=clock_timestamp()+interval '30 seconds'
    where user_id=q.user_id and request_id=q.request_id returning * into q;
  return to_jsonb(q);
end;
$$;

revoke all on function public.hivra_provider_direct_access_valid(public.hivra_agents) from public,anon,authenticated;
revoke all on function public.hivra_model_key_binding(public.hivra_agents) from public,anon,authenticated;
revoke all on function public.admit_hivra_model_key_operation(text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.claim_hivra_launch_model_attempt(text,uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.hivra_provider_direct_access_valid(public.hivra_agents) to service_role;
grant execute on function public.hivra_model_key_binding(public.hivra_agents) to service_role;
grant execute on function public.admit_hivra_model_key_operation(text,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.claim_hivra_launch_model_attempt(text,uuid,uuid,boolean) to service_role;
