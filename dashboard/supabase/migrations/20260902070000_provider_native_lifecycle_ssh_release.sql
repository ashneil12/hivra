-- Admit the 2026.09.02.3 provider bundle. The provider worker protocol and
-- native cleanup closure are unchanged; every Proxmox guest lifecycle SSH/SCP
-- channel now uses the shared VMID-attested Ed25519 host-key boundary.

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
    or not coalesce(t.capabilities#>>'{provisioner,version}' in (
      '2026.08.28.1','2026.08.28.2','2026.08.28.3','2026.08.28.4',
      '2026.08.29.1','2026.08.29.2','2026.08.29.3','2026.08.29.4','2026.08.29.5',
      '2026.08.30.1','2026.08.30.2','2026.08.31.1','2026.08.31.2','2026.08.31.3',
      '2026.08.31.4','2026.09.01.1','2026.09.01.2','2026.09.01.3','2026.09.01.4',
      '2026.09.01.5','2026.09.01.6','2026.09.01.7','2026.09.01.8','2026.09.01.9',
      '2026.09.02.1','2026.09.02.2','2026.09.02.3'),false)
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

revoke all on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)
  from public,anon,authenticated;
grant execute on function public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)
  to service_role;

create or replace function public.hivra_provider_native_identity_valid(
  p_identity jsonb,p_agent_id uuid,p_operation_id uuid
) returns boolean language sql immutable security invoker set search_path=public,pg_temp as $$
  select (jsonb_typeof(p_identity)='object'
    and p_identity-array['version','agentId','operationId','bundle','nativeCleanup']='{}'::jsonb
    and p_identity->'version'='2'::jsonb
    and p_identity->>'agentId'=p_agent_id::text and p_identity->>'operationId'=p_operation_id::text
    and jsonb_typeof(p_identity->'bundle')='object'
    and (p_identity->'bundle')-array['version','state','scopeSha256','bundleSha256','provisionerVersion']='{}'::jsonb
    and p_identity->'bundle'->'version'='1'::jsonb and p_identity->'bundle'->>'state'='bundle_installed'
    and jsonb_typeof(p_identity->'bundle'->'scopeSha256')='string'
    and p_identity->'bundle'->>'scopeSha256' ~ '^[0-9a-f]{64}$'
    and (
      (p_identity->'bundle'->>'bundleSha256'='8f74ff4ce921d21c84784fdff6885f2ff60b1e83b9c1f3609a95422982bc16ec' and p_identity->'bundle'->>'provisionerVersion'='2026.08.31.3')
      or (p_identity->'bundle'->>'bundleSha256'='bb67d66049af310db6f91b9627bd6e0bc25543e9629c9fc264d816b7ffb7b3aa' and p_identity->'bundle'->>'provisionerVersion'='2026.08.31.4')
      or (p_identity->'bundle'->>'bundleSha256'='efa15f664808c3afa5b1a36a0763d39338d20cbe03acc5c15dc8f82f8e2957b9' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.1')
      or (p_identity->'bundle'->>'bundleSha256'='a0a1504fa588332adf3b5a43a88164d61f138f0de61a0d10426f5321cd81b06f' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.2')
      or (p_identity->'bundle'->>'bundleSha256'='1d42b30677175bdd07939a98d219321f503b8180934df70e8d633c9243c38f67' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.3')
      or (p_identity->'bundle'->>'bundleSha256'='d5b7864c3d1e02bea13ea2d129de289b82cde59389d284eaba56b64e34e1f620' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.4')
      or (p_identity->'bundle'->>'bundleSha256'='986bcf1fcd3f6b0f1d7d3e6fdeec795431ec959b7540e02ce6c6b7f3a7c47cc5' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.5')
      or (p_identity->'bundle'->>'bundleSha256'='96fd54d3001f8dffbe2419c55ad5669a18b0f3d6ff90bc5dab74e699e9cf8cd1' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.6')
      or (p_identity->'bundle'->>'bundleSha256'='88c0c157e03a0e6f70ccd7a3d3b7e6e4ea890638210cdde53a7b39f878994314' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.7')
      or (p_identity->'bundle'->>'bundleSha256'='d641a55cb724a59abf5f5453b44bd00a4078be923956b5b82f11a0fd2fbcb4e0' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.8')
      or (p_identity->'bundle'->>'bundleSha256'='d2666888d06a02ec75a8edb771e32487e57f54588d527e004bfe134dedb5d246' and p_identity->'bundle'->>'provisionerVersion'='2026.09.01.9')
      or (p_identity->'bundle'->>'bundleSha256'='7122d4a6b6c0ce4e498841800ad0b372a76e57ca6d67f24245f070df7a61787c' and p_identity->'bundle'->>'provisionerVersion'='2026.09.02.1')
      or (p_identity->'bundle'->>'bundleSha256'='8897b6ffe01a8182536546834f2025e738435893969ea98aa9b2aff3b2f49730' and p_identity->'bundle'->>'provisionerVersion'='2026.09.02.2')
      or (p_identity->'bundle'->>'bundleSha256'='78fcc31893fe1837dff872d3feb05f374532e35c568a6d99477d19f276c39374' and p_identity->'bundle'->>'provisionerVersion'='2026.09.02.3')
    )
    and jsonb_typeof(p_identity->'nativeCleanup')='object'
    and (p_identity->'nativeCleanup')-array['profile','closureSha256']='{}'::jsonb
    and p_identity->'nativeCleanup'->>'profile'='deepseek-owned-service-v1'
    and p_identity->'nativeCleanup'->>'closureSha256'='ec0ab1faeadd46c4a21f03bde01b24e88f5d2a7e89f632b9c0e193cb51713b91'
  ) is true;
$$;

revoke all on function public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.hivra_provider_native_identity_valid(jsonb,uuid,uuid)
  to service_role;
