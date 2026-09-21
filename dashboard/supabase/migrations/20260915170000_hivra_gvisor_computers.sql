-- Direct-host gVisor is an application-kernel Computer adapter using the same
-- Hivra computer record and lifecycle axes. It is Linux terminal-only and does
-- not inherit Proxmox/provider-VM isolation or desktop capability claims.

alter table public.deployment_targets
  drop constraint deployment_targets_supported_isolation_drivers_check,
  add constraint deployment_targets_supported_isolation_drivers_check
    check (supported_isolation_drivers <@ array['proxmox-kvm','provider-vm','gvisor-runsc']::text[]),
  drop constraint deployment_targets_isolation_class_check,
  add constraint deployment_targets_isolation_class_check
    check (isolation_class in ('hardware-vm','provider-vm','application-kernel'));

alter table public.hivra_agents
  drop constraint hivra_agents_computer_substrate_check,
  add constraint hivra_agents_computer_substrate_check
    check (computer_substrate in ('proxmox-kvm','provider-vm','gvisor')),
  drop constraint hivra_agents_computer_profile_check,
  add constraint hivra_agents_computer_profile_check
    check (computer_profile is null or computer_profile in ('ubuntu-desktop','omarchy','windows','linux-terminal')),
  add column gvisor_sandbox_id uuid,
  add column gvisor_adapter_version text,
  add column gvisor_adapter_sha256 text,
  add column gvisor_runtime_sha256 text,
  add column gvisor_launch_request_id uuid,
  add column gvisor_observation jsonb,
  add column gvisor_cleanup_receipt jsonb;

alter table public.hivra_agents
  drop constraint hivra_agents_provider_identity_check,
  add constraint hivra_agents_provider_identity_check check ((
    (computer_substrate='proxmox-kvm' and provider_capacity_order_id is null
      and provider_enrollment_attempt_id is null and provider_server_id is null
      and gvisor_sandbox_id is null and gvisor_adapter_version is null
      and gvisor_adapter_sha256 is null and gvisor_runtime_sha256 is null)
    or (computer_substrate='provider-vm' and deployment_mode='self-managed' and vmid is null
      and provider_capacity_order_id is not null and provider_enrollment_attempt_id is not null
      and provider_server_id ~ '^[1-9][0-9]{0,15}$'
      and provider_server_id::numeric <= 9007199254740991
      and gvisor_sandbox_id is null and gvisor_adapter_version is null
      and gvisor_adapter_sha256 is null and gvisor_runtime_sha256 is null)
    or (computer_substrate='gvisor' and deployment_mode='self-managed' and vmid is null
      and provider_capacity_order_id is null and provider_enrollment_attempt_id is null
      and provider_server_id is null and gvisor_sandbox_id is not null
      and gvisor_adapter_version='2026.09.15.1'
      and gvisor_adapter_sha256 ~ '^[0-9a-f]{64}$' and gvisor_runtime_sha256 ~ '^[0-9a-f]{64}$'
      and computer_profile='linux-terminal' and type='linux-terminal'
      and cpu_max=cpu and ram_max=ram
      and ((status<>'deleted' and infrastructure_connection_id is not null and deployment_target_id is not null
        and infrastructure_connection_revision is not null)
        or (status='deleted' and infrastructure_connection_id is null and deployment_target_id is null
          and infrastructure_connection_revision is null
          and gvisor_cleanup_receipt->'binding'->>'adapterSha256'=gvisor_adapter_sha256
          and gvisor_cleanup_receipt->'binding'->>'runtimeSha256'=gvisor_runtime_sha256))
      and infrastructure_binding_token_enforced is true)
  ) is true);

create unique index hivra_agents_gvisor_sandbox_unique
  on public.hivra_agents(deployment_target_id,gvisor_sandbox_id)
  where computer_substrate='gvisor';
create unique index hivra_agents_gvisor_launch_request_unique
  on public.hivra_agents(user_id,gvisor_launch_request_id)
  where gvisor_launch_request_id is not null;

alter table public.hivra_agents
  add constraint hivra_agents_gvisor_observation_check check (
    computer_substrate<>'gvisor' or (
      (gvisor_observation is null or (
        jsonb_typeof(gvisor_observation)='object'
        and gvisor_observation->>'computerId'=id::text
        and gvisor_observation->>'sandboxId'=gvisor_sandbox_id::text
        and (gvisor_observation->>'state'='absent' or (
          gvisor_observation->>'isolationClass'='application-kernel'
          and gvisor_observation->>'isolationDriver'='gvisor-runsc'
          and gvisor_observation->>'runtime'='runsc'
          and gvisor_observation->>'reservationEqualsMaximum'='true'))))
      and (gvisor_cleanup_receipt is null or (
        jsonb_typeof(gvisor_cleanup_receipt)='object'
        and gvisor_cleanup_receipt->>'computerId'=id::text
        and gvisor_cleanup_receipt->>'sandboxId'=gvisor_sandbox_id::text
        and gvisor_cleanup_receipt->>'state'='absent'))
      and (status<>'deleted' or (
        jsonb_typeof(gvisor_cleanup_receipt->'binding')='object'
        and gvisor_cleanup_receipt->'binding'->>'connectionId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and gvisor_cleanup_receipt->'binding'->>'targetId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and (gvisor_cleanup_receipt->'binding'->>'connectionRevision')::bigint>0
        and gvisor_cleanup_receipt->'binding'->>'adapterSha256'=gvisor_adapter_sha256
        and gvisor_cleanup_receipt->'binding'->>'runtimeSha256'=gvisor_runtime_sha256))
    ));

create or replace function public.guard_hivra_gvisor_computer()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if tg_op<>'INSERT' and old.computer_substrate='gvisor' then
    if tg_op='DELETE' then
      raise exception 'Retain gVisor computer lifecycle evidence' using errcode='55006';
    end if;
    if row(new.id,new.user_id,new.computer_substrate,new.deployment_mode,new.infrastructure_connection_id,
      new.deployment_target_id,new.infrastructure_connection_revision,new.gvisor_sandbox_id,
      new.gvisor_adapter_version,new.gvisor_adapter_sha256,new.gvisor_runtime_sha256,
      new.infrastructure_binding_token_hash,new.infrastructure_binding_token_enforced)
      is distinct from row(old.id,old.user_id,old.computer_substrate,old.deployment_mode,old.infrastructure_connection_id,
      old.deployment_target_id,old.infrastructure_connection_revision,old.gvisor_sandbox_id,
      old.gvisor_adapter_version,old.gvisor_adapter_sha256,old.gvisor_runtime_sha256,
      old.infrastructure_binding_token_hash,old.infrastructure_binding_token_enforced)
    then
      if not ((
        new.infrastructure_connection_revision<>old.infrastructure_connection_revision
        and row(new.id,new.user_id,new.computer_substrate,new.deployment_mode,new.infrastructure_connection_id,
          new.deployment_target_id,new.gvisor_sandbox_id,new.gvisor_adapter_version,new.gvisor_adapter_sha256,
          new.gvisor_runtime_sha256,new.infrastructure_binding_token_hash,new.infrastructure_binding_token_enforced)
        is not distinct from row(old.id,old.user_id,old.computer_substrate,old.deployment_mode,old.infrastructure_connection_id,
          old.deployment_target_id,old.gvisor_sandbox_id,old.gvisor_adapter_version,old.gvisor_adapter_sha256,
          old.gvisor_runtime_sha256,old.infrastructure_binding_token_hash,old.infrastructure_binding_token_enforced)
        and old.operation_id is null and new.operation_id is null and old.status<>'deleted'
        and exists (select 1 from public.infrastructure_connections c join public.deployment_targets t
          on t.connection_id=c.id and t.user_id=c.user_id
          where c.id=new.infrastructure_connection_id and c.user_id=new.user_id
            and c.revision=new.infrastructure_connection_revision
            and c.pending_binding_rebind_from_revision=old.infrastructure_connection_revision
            and c.status='ready' and t.id=new.deployment_target_id
            and t.evidence_connection_revision=new.infrastructure_connection_revision
            and t.status='ready' and t.capabilities->>'kind'='gvisor'
            and t.capabilities->'adapter'->>'sha256'=new.gvisor_adapter_sha256
            and t.capabilities->'runtime'->>'sha256'=new.gvisor_runtime_sha256)
      ) or (
        old.status<>'deleted' and new.status='deleted'
        and new.infrastructure_connection_id is null and new.deployment_target_id is null
        and new.infrastructure_connection_revision is null
        and row(new.id,new.user_id,new.computer_substrate,new.deployment_mode,new.gvisor_sandbox_id,
          new.gvisor_adapter_version,new.gvisor_adapter_sha256,new.gvisor_runtime_sha256,
          new.infrastructure_binding_token_hash,new.infrastructure_binding_token_enforced)
        is not distinct from row(old.id,old.user_id,old.computer_substrate,old.deployment_mode,old.gvisor_sandbox_id,
          old.gvisor_adapter_version,old.gvisor_adapter_sha256,old.gvisor_runtime_sha256,
          old.infrastructure_binding_token_hash,old.infrastructure_binding_token_enforced)
        and new.gvisor_cleanup_receipt->'binding'->>'connectionId'=old.infrastructure_connection_id::text
        and new.gvisor_cleanup_receipt->'binding'->>'targetId'=old.deployment_target_id::text
        and (new.gvisor_cleanup_receipt->'binding'->>'connectionRevision')::bigint=old.infrastructure_connection_revision
        and new.gvisor_cleanup_receipt->'binding'->>'adapterSha256'=old.gvisor_adapter_sha256
        and new.gvisor_cleanup_receipt->'binding'->>'runtimeSha256'=old.gvisor_runtime_sha256
      )) then raise exception 'gVisor computer authority is immutable' using errcode='55006'; end if;
    end if;
    if old.status='deleted' and new.status<>'deleted' then
      raise exception 'A deleted gVisor computer cannot be reused' using errcode='55006'; end if;
    if new.status='deleted' and old.status<>'deleted' and (
      new.gvisor_cleanup_receipt is null
      or new.gvisor_cleanup_receipt->>'computerId' is distinct from old.id::text
      or new.gvisor_cleanup_receipt->>'sandboxId' is distinct from old.gvisor_sandbox_id::text
      or new.gvisor_cleanup_receipt->>'state' is distinct from 'absent'
      or new.gvisor_cleanup_receipt->'binding'->>'connectionId' is distinct from old.infrastructure_connection_id::text
      or new.gvisor_cleanup_receipt->'binding'->>'targetId' is distinct from old.deployment_target_id::text
      or new.gvisor_cleanup_receipt->'binding'->>'connectionRevision' is distinct from old.infrastructure_connection_revision::text)
    then raise exception 'gVisor cleanup is not verified' using errcode='55006'; end if;
    return new;
  end if;
  if tg_op='DELETE' then return old; end if;
  if new.computer_substrate<>'gvisor' then return new; end if;
  if tg_op<>'INSERT' or new.status<>'provisioning' or new.desired_state<>'running'
    or new.operation_kind<>'provision' or new.operation_id is null
    or new.gvisor_launch_request_id is null or new.proxmox_host<>'__hivra_self_managed_no_ambient_authority__'
  then raise exception 'gVisor launch requires a canonical provision reservation' using errcode='23514'; end if;
  perform 1 from public.deployment_targets t join public.infrastructure_connections c
    on c.id=t.connection_id and c.user_id=t.user_id
    where t.id=new.deployment_target_id and t.user_id=new.user_id
      and t.connection_id=new.infrastructure_connection_id
      and t.evidence_connection_revision=new.infrastructure_connection_revision
      and t.status='ready' and t.isolation_class='application-kernel'
      and t.supported_isolation_drivers=array['gvisor-runsc']::text[]
      and t.capabilities->>'kind'='gvisor' and t.capabilities->>'launchReady'='true'
      and t.capabilities->'adapter'->>'version'=new.gvisor_adapter_version
      and t.capabilities->'adapter'->>'sha256'=new.gvisor_adapter_sha256
      and t.capabilities->'runtime'->>'sha256'=new.gvisor_runtime_sha256
      and c.provider='host' and c.status='ready' and c.revision=new.infrastructure_connection_revision
    for share of t,c;
  if not found then raise exception 'gVisor target authority is unavailable' using errcode='55006'; end if;
  return new;
end;
$$;

create or replace function public.hivra_canonical_surfaces(p_source_kind text,p_payload jsonb,p_is_computer boolean,p_deleted boolean)
returns text[] language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select case
    when coalesce(p_deleted,false) or lower(btrim(coalesce(p_payload->>'status','')))<>'running' then '{}'::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'backend',''))) in ('gateway','webui')
      then array['workspace','terminal','browser','native']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='gvisor'
      then array['terminal']::text[]
    when p_is_computer then array['files','terminal','desktop']::text[]
    when lower(btrim(coalesce(p_payload->>'type',''))) in ('hermes','claude-code','codex','openclaw','agent-zero','deepseek-harness')
      then array['workspace','files','git','terminal']::text[]
    when lower(btrim(coalesce(p_payload->>'type','')))='aeon' then array['workspace']::text[]
    else '{}'::text[] end;
$$;

create or replace function public.hivra_canonical_actions(p_source_kind text,p_payload jsonb,p_is_computer boolean,p_deleted boolean)
returns text[] language sql immutable security invoker set search_path=pg_catalog,pg_temp as $$
  select case
    when coalesce(p_deleted,false) then '{}'::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'backend',''))) not in ('gateway','webui') then '{}'::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'status','')))='running' then array['stop','reboot','delete']::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'status',''))) in ('stopped','paused','suspended') then array['start','delete']::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'status',''))) in ('provisioning','redeploying','restoring','deleting') then array['delete']::text[]
    when p_source_kind='hermes' and lower(btrim(coalesce(p_payload->>'status',''))) in ('error','failed') then array['start','delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='gvisor'
      and lower(btrim(coalesce(p_payload->>'status','')))='running' then array['stop','delete','resize']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='gvisor'
      and lower(btrim(coalesce(p_payload->>'status',''))) in ('stopped','error') then array['start','delete','resize']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='gvisor'
      and lower(btrim(coalesce(p_payload->>'status','')))='provisioning' then array['delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='proxmox-kvm'
      and lower(btrim(coalesce(p_payload->>'status','')))='running' then array['stop','reboot','delete','resize','snapshot','restore']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='proxmox-kvm'
      and lower(btrim(coalesce(p_payload->>'status','')))='stopped' then array['start','delete','resize','snapshot','restore']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'computerSubstrate','')))='proxmox-kvm'
      and lower(btrim(coalesce(p_payload->>'status','')))='error' then array['start','delete','restore']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'status','')))='running' then array['stop','reboot','delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'status',''))) in ('stopped','error') then array['start','delete']::text[]
    when p_is_computer and lower(btrim(coalesce(p_payload->>'status','')))='provisioning' then array['delete']::text[]
    when p_source_kind='hivra' and lower(btrim(coalesce(p_payload->>'type',''))) in ('hermes','claude-code','codex','openclaw','agent-zero','deepseek-harness','aeon')
      and lower(btrim(coalesce(p_payload->>'status',''))) in ('provisioning','running','stopped','error') then array['delete']::text[]
    else '{}'::text[] end;
$$;

create trigger hivra_gvisor_computer_guard
  before insert or update or delete on public.hivra_agents
  for each row execute function public.guard_hivra_gvisor_computer();

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
    or p_target->'externalId' !~ '^gvisor-[0-9a-f]{24}$'
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

-- Preserve the existing self-managed authority guard for VM rows while
-- recognizing the exact, capability-bound application-kernel target used by
-- gVisor. A deleted gVisor tombstone retains only its immutable binding and
-- verified absence receipt so later audits cannot retarget the sandbox ID.
create or replace function public.enforce_hivra_agent_deployment_authority()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
declare
  v_connection_revision bigint; v_connection_status text;
  v_connection_pending_rebind_from_revision bigint; v_target_revision bigint;
  v_target_status text; v_target_capabilities jsonb; v_target_isolation_class text;
  v_credential_recovery_completion boolean := false;
  v_pending_gvisor_cleanup_claim boolean := false;
begin
  if new.deployment_mode='hivra-managed' then
    if new.infrastructure_connection_id is not null or new.deployment_target_id is not null
      or new.infrastructure_connection_revision is not null
      or new.proxmox_host='__hivra_self_managed_no_ambient_authority__'
    then raise exception 'managed Hivra agent carries self-managed authority' using errcode='23514'; end if;
    return new;
  end if;
  if new.deployment_mode<>'self-managed' then raise exception 'Hivra deployment mode is invalid' using errcode='23514'; end if;
  if new.proxmox_host<>'__hivra_self_managed_no_ambient_authority__' then
    raise exception 'self-managed Hivra agent lacks rollback authority fuse' using errcode='23514';
  end if;
  if new.status='deleted' and new.computer_substrate<>'gvisor' then
    if new.infrastructure_connection_id is not null or new.deployment_target_id is not null
      or new.infrastructure_connection_revision is not null
    then raise exception 'deleted self-managed Hivra agent retained provider authority' using errcode='23514'; end if;
    return new;
  end if;
  if new.status='deleted' and new.computer_substrate='gvisor' then
    if new.infrastructure_connection_id is not null or new.deployment_target_id is not null
      or new.infrastructure_connection_revision is not null
      or new.gvisor_cleanup_receipt is null or new.gvisor_cleanup_receipt->>'state' is distinct from 'absent'
      or new.gvisor_cleanup_receipt->'binding'->>'adapterSha256' is distinct from new.gvisor_adapter_sha256
      or new.gvisor_cleanup_receipt->'binding'->>'runtimeSha256' is distinct from new.gvisor_runtime_sha256
    then raise exception 'deleted gVisor computer lacks detached verified absence evidence' using errcode='23514'; end if;
    return new;
  end if;
  if new.infrastructure_connection_id is null or new.deployment_target_id is null
    or new.infrastructure_connection_revision is null
  then raise exception 'self-managed Hivra authority binding is incomplete' using errcode='23514'; end if;

  select revision,status,pending_binding_rebind_from_revision
    into v_connection_revision,v_connection_status,v_connection_pending_rebind_from_revision
  from public.infrastructure_connections where id=new.infrastructure_connection_id and user_id=new.user_id for key share;
  if not found then raise exception 'self-managed Hivra connection revision is stale or unavailable' using errcode='55000'; end if;
  if tg_op='UPDATE' then
    v_credential_recovery_completion := old.deployment_mode='self-managed' and old.operation_id is not null
      and ((new.operation_id is not distinct from old.operation_id and new.operation_kind is not distinct from old.operation_kind)
        or (new.operation_id is null and new.operation_kind is null))
      and new.infrastructure_connection_id=old.infrastructure_connection_id
      and new.deployment_target_id=old.deployment_target_id
      and new.infrastructure_connection_revision=old.infrastructure_connection_revision
      and v_connection_pending_rebind_from_revision=old.infrastructure_connection_revision
      and v_connection_revision>old.infrastructure_connection_revision and v_connection_status in ('pending','error');
    v_pending_gvisor_cleanup_claim := old.computer_substrate='gvisor' and old.status<>'deleted'
      and old.operation_id is null and new.operation_id is not null and new.operation_kind='delete'
      and new.desired_state='deleted' and new.status='provisioning'
      and new.infrastructure_connection_id=old.infrastructure_connection_id
      and new.deployment_target_id=old.deployment_target_id
      and new.infrastructure_connection_revision=old.infrastructure_connection_revision
      and v_connection_pending_rebind_from_revision=old.infrastructure_connection_revision
      and v_connection_revision=old.infrastructure_connection_revision+1 and v_connection_status='pending';
  end if;
  if not v_credential_recovery_completion and not v_pending_gvisor_cleanup_claim and (v_connection_status<>'ready'
    or v_connection_revision<>new.infrastructure_connection_revision)
  then raise exception 'self-managed Hivra connection revision is stale or unavailable' using errcode='55000'; end if;

  select evidence_connection_revision,status,capabilities,isolation_class
    into v_target_revision,v_target_status,v_target_capabilities,v_target_isolation_class
  from public.deployment_targets where id=new.deployment_target_id
    and connection_id=new.infrastructure_connection_id and user_id=new.user_id for key share;
  if not found
    or (v_credential_recovery_completion and v_target_revision<>old.infrastructure_connection_revision)
    or (not v_credential_recovery_completion and not v_pending_gvisor_cleanup_claim and (
      v_target_revision<>new.infrastructure_connection_revision or v_target_status<>'ready'
      or not coalesce(v_target_capabilities @> '{"launchReady":true}'::jsonb,false)
      or (new.computer_substrate='gvisor' and (v_target_isolation_class<>'application-kernel'
        or v_target_capabilities->>'kind'<>'gvisor'
        or v_target_capabilities->'adapter'->>'version'<>'2026.09.15.1'))
      or (new.computer_substrate<>'gvisor' and v_target_isolation_class<>'hardware-vm')
    ))
    or (v_pending_gvisor_cleanup_claim and (
      v_target_revision<>old.infrastructure_connection_revision
      or v_target_capabilities->>'kind'<>'gvisor'
      or v_target_capabilities->'adapter'->>'sha256'<>old.gvisor_adapter_sha256
      or v_target_capabilities->'runtime'->>'sha256'<>old.gvisor_runtime_sha256))
  then raise exception 'self-managed Hivra deployment target evidence is stale or unavailable' using errcode='55000'; end if;
  return new;
end;
$$;
