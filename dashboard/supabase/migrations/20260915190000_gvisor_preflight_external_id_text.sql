-- The original gVisor preflight RPC applied the text regex operator to a
-- jsonb value. PostgreSQL resolves no jsonb !~ operator, so every otherwise
-- valid target failed with 42883 before it could be committed. Replace the
-- applied function in place and extract externalId as text before matching.

create or replace function public.commit_hivra_gvisor_target_preflight(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint,
  p_checked_at timestamptz, p_run_id uuid, p_target jsonb
) returns public.deployment_targets
language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_target public.deployment_targets%rowtype;
  v_existing_target public.deployment_targets%rowtype;
  v_rebind_from bigint;
begin
  select * into v_connection from public.infrastructure_connections
    where id=p_connection_id and user_id=p_user_id and revision=p_expected_revision for update;
  if not found or v_connection.provider<>'host' or v_connection.preflight_run_id is distinct from p_run_id then
    raise exception 'gVisor connection authority changed' using errcode='55000';
  end if;
  if jsonb_typeof(p_target) is distinct from 'object'
    or not coalesce(p_target @> '{"status":"ready","isolationClass":"application-kernel","supportedIsolationDrivers":["gvisor-runsc"],"capabilities":{"kind":"gvisor","launchReady":true,"adapter":{"version":"2026.09.15.1"},"runtime":{"path":"/usr/local/bin/runsc"},"runtimeCompatibility":{"contractVersion":1,"supportedWorkloadKinds":["linux-terminal"]},"resourcePolicy":{"reservationEqualsMaximum":true,"aggregateAdmission":"serialized-host-headroom-v1"},"access":{"terminal":"owner-gated-command-v1","publicPorts":false},"desktop":false,"windows":false}}'::jsonb,false)
    or jsonb_typeof(p_target->'capacity') is distinct from 'object'
    or jsonb_typeof(p_target->'capacity'->'cpu'->'totalCores') is distinct from 'number'
    or jsonb_typeof(p_target->'capacity'->'memoryBytes'->'total') is distinct from 'number'
    or jsonb_typeof(p_target->'capacity'->'memoryBytes'->'available') is distinct from 'number'
    or jsonb_typeof(p_target->'capacity'->'storageBytes'->'total') is distinct from 'number'
    or jsonb_typeof(p_target->'capacity'->'storageBytes'->'available') is distinct from 'number'
    or jsonb_typeof(p_target->'capabilities'->'adapter'->'sha256') is distinct from 'string'
    or jsonb_typeof(p_target->'capabilities'->'runtime'->'sha256') is distinct from 'string'
    or jsonb_typeof(p_target->'capabilities'->'hostIdentityDigest') is distinct from 'string'
    or jsonb_typeof(p_target->'externalId') is distinct from 'string'
    or (p_target->'capacity'->'cpu'->>'totalCores')::numeric<1
    or (p_target->'capacity'->'memoryBytes'->>'total')::numeric<1073741824
    or (p_target->'capacity'->'memoryBytes'->>'available')::numeric<0
    or (p_target->'capacity'->'memoryBytes'->>'available')::numeric>(p_target->'capacity'->'memoryBytes'->>'total')::numeric
    or (p_target->'capacity'->'storageBytes'->>'total')::numeric<1
    or (p_target->'capacity'->'storageBytes'->>'available')::numeric<0
    or (p_target->'capacity'->'storageBytes'->>'available')::numeric>(p_target->'capacity'->'storageBytes'->>'total')::numeric
    or p_target->>'status' is distinct from 'ready'
    or p_target->>'isolationClass'<>'application-kernel'
    or p_target->'capabilities'->>'kind'<>'gvisor'
    or p_target->'capabilities'->>'launchReady'<>'true'
    or p_target->'capabilities'->'adapter'->>'version'<>'2026.09.15.1'
    or (p_target->'capabilities'->'adapter'->>'sha256')!~'^[0-9a-f]{64}$'
    or p_target->'capabilities'->'runtime'->>'path'<>'/usr/local/bin/runsc'
    or (p_target->'capabilities'->'runtime'->>'sha256')!~'^[0-9a-f]{64}$'
    or p_target->'capabilities'->'runtimeCompatibility'->>'contractVersion'<>'1'
    or p_target->'capabilities'->'runtimeCompatibility'->'supportedWorkloadKinds'<>'["linux-terminal"]'::jsonb
    or p_target->'capabilities'->'resourcePolicy'->>'reservationEqualsMaximum'<>'true'
    or p_target->'capabilities'->'resourcePolicy'->>'aggregateAdmission'<>'serialized-host-headroom-v1'
    or p_target->'capabilities'->'access'->>'terminal'<>'owner-gated-command-v1'
    or p_target->'capabilities'->'access'->>'publicPorts'<>'false'
    or p_target->'capabilities'->>'desktop'<>'false'
    or p_target->'capabilities'->>'windows'<>'false'
    or p_target->>'externalId' !~ '^gvisor-[0-9a-f]{24}$'
    or (p_target->'capabilities'->>'hostIdentityDigest')!~'^[0-9a-f]{64}$'
    or p_target->>'externalId' <> ('gvisor-' || left(p_target->'capabilities'->>'hostIdentityDigest',24))
    or p_target->'supportedIsolationDrivers' <> '["gvisor-runsc"]'::jsonb
  then raise exception 'gVisor target evidence is invalid' using errcode='22023'; end if;

  select * into v_existing_target from public.deployment_targets
    where connection_id=p_connection_id and external_id=p_target->>'externalId' for update;
  if found and (v_existing_target.user_id is distinct from p_user_id
    or v_existing_target.capabilities->>'kind' is distinct from 'gvisor'
    or v_existing_target.capabilities->>'hostIdentityDigest' is distinct from p_target->'capabilities'->>'hostIdentityDigest')
  then raise exception 'gVisor target identity changed' using errcode='55000'; end if;
  if exists(select 1 from public.hivra_agents a join public.deployment_targets t on t.id=a.deployment_target_id
    where a.infrastructure_connection_id=p_connection_id and a.user_id=p_user_id
      and a.computer_substrate='gvisor' and a.status<>'deleted' and t.external_id=p_target->>'externalId'
      and (a.gvisor_adapter_sha256<>p_target->'capabilities'->'adapter'->>'sha256'
        or a.gvisor_runtime_sha256<>p_target->'capabilities'->'runtime'->>'sha256'))
  then raise exception 'gVisor runtime identity changed while computers remain' using errcode='55000'; end if;

  update public.deployment_targets set status='unavailable',
    capabilities=jsonb_set(capabilities,'{launchReady}','false'::jsonb,true),
    supported_isolation_drivers='{}'::text[], isolation_class=null,
    last_error_code='PREFLIGHT_SUPERSEDED'
    where connection_id=p_connection_id and user_id=p_user_id
      and capabilities->>'kind'='gvisor' and external_id<>p_target->>'externalId';

  insert into public.deployment_targets(user_id,connection_id,external_id,display_name,status,capacity,
    capabilities,supported_isolation_drivers,isolation_class,last_preflight_at,last_error_code,evidence_connection_revision)
  values(p_user_id,p_connection_id,p_target->>'externalId',left(v_connection.name||' — gVisor',128),'ready',
    p_target->'capacity',p_target->'capabilities',array['gvisor-runsc']::text[],'application-kernel',p_checked_at,null,p_expected_revision)
  on conflict(connection_id,external_id) do update set
    user_id=excluded.user_id,display_name=excluded.display_name,status=excluded.status,capacity=excluded.capacity,
    capabilities=excluded.capabilities,supported_isolation_drivers=excluded.supported_isolation_drivers,
    isolation_class=excluded.isolation_class,last_preflight_at=excluded.last_preflight_at,last_error_code=null,
    evidence_connection_revision=excluded.evidence_connection_revision
  returning * into v_target;

  v_rebind_from:=v_connection.pending_binding_rebind_from_revision;
  if v_rebind_from is not null and v_rebind_from<>p_expected_revision-1 then
    raise exception 'gVisor connection rebind revision is not contiguous' using errcode='55000';
  end if;
  update public.infrastructure_connections set status='ready',last_checked_at=p_checked_at,last_error_code=null,
    preflight_run_id=null,preflight_started_at=null,preflight_lease_expires_at=null
    where id=p_connection_id and user_id=p_user_id;
  if v_rebind_from is not null then
    if exists(select 1 from public.hivra_agents where infrastructure_connection_id=p_connection_id
      and user_id=p_user_id and computer_substrate='gvisor' and status<>'deleted'
      and (infrastructure_connection_revision<>v_rebind_from or operation_id is not null
        or deployment_target_id<>v_target.id
        or gvisor_adapter_sha256<>p_target->'capabilities'->'adapter'->>'sha256'
        or gvisor_runtime_sha256<>p_target->'capabilities'->'runtime'->>'sha256'))
    then raise exception 'gVisor computers cannot be rebound safely' using errcode='55000'; end if;
    update public.hivra_agents set infrastructure_connection_revision=p_expected_revision
      where infrastructure_connection_id=p_connection_id and user_id=p_user_id
        and computer_substrate='gvisor' and status<>'deleted'
        and infrastructure_connection_revision=v_rebind_from and operation_id is null;
    update public.infrastructure_connections set pending_binding_rebind_from_revision=null
      where id=p_connection_id and user_id=p_user_id;
  end if;
  return v_target;
end;
$$;

revoke all on function public.commit_hivra_gvisor_target_preflight(text,uuid,bigint,timestamptz,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.commit_hivra_gvisor_target_preflight(text,uuid,bigint,timestamptz,uuid,jsonb) to service_role;
