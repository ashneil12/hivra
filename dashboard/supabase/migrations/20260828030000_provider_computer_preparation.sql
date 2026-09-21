-- Publish one inspected, bundle-prepared computer under its original setup
-- lease. This does NOT enable agent launch: status and launchReady stay gated.
-- No new operation lane, credentials, or provider resource is introduced.
create or replace function public.publish_prepared_provider_computer(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,
  p_attempt_id uuid,p_quote text,p_server text,p_lease_id uuid,
  p_snapshot jsonb,p_receipt jsonb,p_power_action jsonb
) returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_order public.infrastructure_capacity_orders%rowtype;
  v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_boot public.infrastructure_first_boot_operations%rowtype;
  v_target public.deployment_targets%rowtype;
  v_host jsonb; v_capacity jsonb; v_caps jsonb; v_scope text;
  v_observed timestamptz; v_host_digest text;
begin
  -- The parent lock order matches reservation, retirement and cleanup.
  select * into v_connection from public.infrastructure_connections
    where id=p_connection_id and user_id=p_user_id for update;
  if not found or v_connection.provider<>'hetzner-cloud' or v_connection.status<>'ready'
    or v_connection.revision<>p_revision then return null; end if;
  select * into v_order from public.infrastructure_capacity_orders
    where id=p_order_id and user_id=p_user_id and connection_id=p_connection_id
      and connection_revision=p_revision for update;
  if not found or v_order.status<>'created_off' or v_order.active_connection_id is distinct from p_connection_id
    or v_order.quote_fingerprint_sha256 is distinct from p_quote
    or v_order.provider_resource_id is distinct from p_server
    or v_order.provider_server_status is distinct from 'accepted'
    or v_order.provider_ssh_key_status is distinct from 'accepted'
    or v_order.provider_creation_receipt->>'serverId' is distinct from p_server then return null; end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments
    where order_id=p_order_id and attempt_id=p_attempt_id and user_id=p_user_id
      and connection_id=p_connection_id and connection_revision=p_revision for update;
  if not found or v_enrollment.phase<>'enrolled' or v_enrollment.provider_server_id is distinct from p_server
    or v_enrollment.quote_fingerprint_sha256 is distinct from p_quote
    or v_enrollment.host_public_key is null then return null; end if;
  select * into v_boot from public.infrastructure_first_boot_operations
    where order_id=p_order_id and attempt_id=p_attempt_id and user_id=p_user_id
      and connection_id=p_connection_id and connection_revision=p_revision for update;
  if not found or v_boot.lease_id is distinct from p_lease_id or p_lease_id is null
    or v_boot.lease_expires_at is null or v_boot.lease_expires_at<=clock_timestamp()
    or v_boot.abandoned_at is not null or v_boot.quote_fingerprint_sha256 is distinct from p_quote
    or v_boot.provider_server_id is distinct from p_server or v_boot.firewall_verified_at is null
    or v_boot.firewall_receipt is null or v_boot.power_on_action is null or v_boot.power_on_post_attempted_at is null
    or exists(select 1 from public.hivra_agents where provider_capacity_order_id=p_order_id)
    then return null; end if;
  -- Enrollment can arrive before the power-on poll. Persist the exact fresh
  -- terminal action under this enrolled lease (also after token expiry), not
  -- through the expired one-time delivery checkpoint or an inferred success.
  if public.is_valid_first_boot_power_action(p_power_action,p_server) is distinct from true
    or p_power_action->>'status' is distinct from 'success'
    or v_boot.power_on_action-'status' is distinct from p_power_action-'status'
    or (v_boot.power_on_action->>'status'<>'running' and v_boot.power_on_action is distinct from p_power_action)
    then return null; end if;

  -- Fresh discovery and receipt must name this exact lease, owner binding and
  -- enrolled host. SQL does not infer preparation from provider power state.
  if jsonb_typeof(p_snapshot) is distinct from 'object' or jsonb_typeof(p_receipt) is distinct from 'object'
    or p_snapshot->>'discoveryId' is distinct from p_lease_id::text
    or p_snapshot->>'connectionId' is distinct from p_connection_id::text
    or p_snapshot->'connectionRevision' is distinct from to_jsonb(p_revision)
    or p_snapshot->>'connectionProvider' is distinct from 'hetzner-cloud'
    or p_snapshot->>'capacityOrderId' is distinct from p_order_id::text
    or p_snapshot->>'enrollmentAttemptId' is distinct from p_attempt_id::text
    or p_snapshot->>'providerServerId' is distinct from p_server
    or p_snapshot->'contractVersion' is distinct from '1'::jsonb
    or p_receipt->'version' is distinct from '1'::jsonb
    or p_receipt->>'state' is distinct from 'bundle_installed'
    or coalesce(p_receipt->>'bundleSha256','') !~ '^[0-9a-f]{64}$'
    or coalesce(p_receipt->>'provisionerVersion','') !~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]+$'
    or (p_receipt-array['version','state','bundleSha256','scopeSha256','provisionerVersion'])<>'{}'::jsonb
    then return null; end if;
  v_host_digest:=encode(sha256(decode(split_part(v_enrollment.host_public_key,' ',2),'base64')),'hex');
  if p_snapshot->>'hostIdentityDigest' is distinct from v_host_digest then return null; end if;
  -- Stable JSON tuple, matching providerGuestBundleScopeSha256 (no spaces
  -- between tuple elements; spaces inside owner strings remain untouched).
  select '['||string_agg(value::text,',' order by ordinality)||']' into v_scope
    from jsonb_array_elements(jsonb_build_array('hivra/provider-bundle/v1',p_user_id,p_connection_id::text,
      p_revision,p_order_id::text,p_attempt_id::text,p_quote,v_enrollment.recipe_version,p_server)) with ordinality;
  if p_receipt->>'scopeSha256' is distinct from encode(sha256(convert_to(v_scope,'UTF8')),'hex') then return null; end if;
  begin
    v_observed:=(p_snapshot->>'observedAt')::timestamptz;
    if v_observed is null or v_observed<clock_timestamp()-interval '30 seconds'
      or v_observed>clock_timestamp()+interval '5 seconds'
      or (p_snapshot->>'expiresAt')::timestamptz is distinct from v_observed+interval '15 minutes'
      then return null; end if;
  exception when others then return null; end;
  v_host:=p_snapshot->'host';
  if not coalesce(v_host @> '{"os":{"family":"linux","id":"ubuntu","versionId":"22.04"},"kernel":{"architecture":"amd64"},"environment":{"effectivePrivilege":"root","virtualization":"virtual-machine","packageManagers":["apt"]}}'::jsonb,false)
    then return null; end if;
  v_capacity:=jsonb_build_object('cpu',jsonb_build_object('totalCores',v_host#>'{capacity,cpu,logicalCores}','utilizationRatio',null),
    'memoryBytes',v_host#>'{capacity,memoryBytes}','storageBytes',v_host#>'{capacity,rootStorageBytes}');
  -- All measurements must be positive, bounded integers; neither missing
  -- facts nor strings masquerading as numbers may publish usable capacity.
  if exists(select 1 from (values (v_capacity#>'{cpu,totalCores}'),(v_capacity#>'{memoryBytes,total}'),
    (v_capacity#>'{memoryBytes,available}'),(v_capacity#>'{storageBytes,total}'),(v_capacity#>'{storageBytes,available}')) as n(value)
    where jsonb_typeof(value) is distinct from 'number' or value::text !~ '^[1-9][0-9]{0,15}$') then return null; end if;
  if (v_capacity#>>'{memoryBytes,available}')::numeric>(v_capacity#>>'{memoryBytes,total}')::numeric
    or (v_capacity#>>'{storageBytes,available}')::numeric>(v_capacity#>>'{storageBytes,total}')::numeric
    or exists(select 1 from (values (v_capacity#>>'{cpu,totalCores}'),(v_capacity#>>'{memoryBytes,total}'),
      (v_capacity#>>'{storageBytes,total}')) as n(value) where value::numeric>9007199254740991)
    then return null; end if;
  v_caps:=jsonb_build_object('kind','provider-vm','provider','hetzner-cloud','capacityOrderId',p_order_id,
    'enrollmentAttemptId',p_attempt_id,'hostIdentityDigest',v_host_digest,'allocation','exclusive-computer',
    'launchReady',false,'runtimeCompatibility',null,'provisioner',jsonb_build_object('configured',true,'ready',true,
      'version',p_receipt->>'provisionerVersion','bundleSha256',p_receipt->>'bundleSha256','scopeSha256',p_receipt->>'scopeSha256'));
  select * into v_target from public.deployment_targets where provider_capacity_order_id=p_order_id for update;
  if found then
    if v_target.provider_retired_at is not null or v_target.user_id is distinct from p_user_id
      or v_target.connection_id is distinct from p_connection_id or v_target.evidence_connection_revision is distinct from p_revision
      or v_target.external_id is distinct from p_server or v_target.capabilities is distinct from v_caps then return null; end if;
    update public.deployment_targets set capacity=v_capacity,last_preflight_at=v_observed,
      updated_at=clock_timestamp() where id=v_target.id returning * into v_target;
  else
    insert into public.deployment_targets(user_id,connection_id,evidence_connection_revision,external_id,display_name,
      status,capacity,capabilities,supported_isolation_drivers,isolation_class,last_preflight_at,last_error_code,provider_capacity_order_id)
      values(p_user_id,p_connection_id,p_revision,p_server,v_order.server_name,'unavailable',v_capacity,v_caps,
        array['provider-vm'],'provider-vm',v_observed,'PROVIDER_ADAPTER_UNAVAILABLE',p_order_id) returning * into v_target;
  end if;
  update public.infrastructure_first_boot_operations set power_on_action=p_power_action,updated_at=clock_timestamp()
    where order_id=p_order_id and attempt_id=p_attempt_id and lease_id=p_lease_id;
  return jsonb_build_object('id',v_target.id,'connectionId',v_target.connection_id,'evidenceConnectionRevision',v_target.evidence_connection_revision,
    'externalId',v_target.external_id,'displayName',v_target.display_name,'status',v_target.status,'capacity',v_target.capacity,
    'capabilities',v_target.capabilities,'supportedIsolationDrivers',to_jsonb(v_target.supported_isolation_drivers),
    'isolationClass',v_target.isolation_class,'lastPreflightAt',v_target.last_preflight_at,'lastErrorCode',v_target.last_error_code,
    'createdAt',v_target.created_at,'updatedAt',v_target.updated_at);
end;
$$;
revoke all on function public.publish_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,text,uuid,jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,text,uuid,jsonb,jsonb,jsonb) to service_role;
