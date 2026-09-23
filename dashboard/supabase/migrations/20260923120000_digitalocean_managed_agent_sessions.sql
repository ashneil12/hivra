-- DigitalOcean Managed Agents (Harness Runtime) as a customer-owned capacity
-- connection. A connection stores one encrypted DigitalOcean personal access
-- token and publishes exactly one serverless deployment target. Each Hivra
-- agent on that target is one DigitalOcean harness session: a provider-managed
-- Firecracker microVM that DigitalOcean creates, isolates, pauses and bills.
--
-- Hivra did not prove that microVM boundary itself, so the target records the
-- provider-attested `provider-microvm` isolation class rather than borrowing
-- `hardware-vm`. This migration is additive: existing providers, substrates and
-- the Proxmox deployment-authority trigger keep their exact definitions.

alter table public.infrastructure_connections
  drop constraint infrastructure_connections_provider_check,
  add constraint infrastructure_connections_provider_check
    check (provider in ('proxmox', 'host', 'hetzner-cloud', 'digitalocean')),
  drop constraint infrastructure_connections_provider_endpoint_check,
  add constraint infrastructure_connections_provider_endpoint_check
    check (
      (
        provider in ('proxmox', 'host')
        and ssh_host is not null
        and btrim(ssh_host) <> ''
        and ssh_port between 1 and 65535
        and ssh_user is not null
        and btrim(ssh_user) <> ''
        and ssh_host_fingerprint_sha256 is not null
        and char_length(ssh_host_fingerprint_sha256) = 64
        and ssh_host_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
      )
      or
      (
        provider in ('hetzner-cloud', 'digitalocean')
        and setup_mode = 'simple'
        and ssh_host is null
        and ssh_port is null
        and ssh_user is null
        and ssh_host_fingerprint_sha256 is null
      )
    );

alter table public.deployment_targets
  drop constraint deployment_targets_supported_isolation_drivers_check,
  add constraint deployment_targets_supported_isolation_drivers_check
    check (supported_isolation_drivers <@ array['proxmox-kvm','provider-vm','gvisor-runsc','do-harness-microvm']::text[]),
  drop constraint deployment_targets_isolation_class_check,
  add constraint deployment_targets_isolation_class_check
    check (isolation_class in ('hardware-vm','provider-vm','application-kernel','provider-microvm'));

-- A DigitalOcean target is the team's serverless Harness Runtime, not a node.
-- Its evidence shape is fixed so no other provider can publish it and no
-- DigitalOcean connection can publish a VM, gVisor or Proxmox claim.
alter table public.deployment_targets
  add constraint deployment_targets_digitalocean_shape_check check (
    (capabilities->>'kind' is distinct from 'digitalocean-managed-agents'
      and not ('do-harness-microvm' = any(supported_isolation_drivers))
      and isolation_class is distinct from 'provider-microvm')
    or (capabilities->>'kind' = 'digitalocean-managed-agents'
      and external_id = 'do-harness-runtime'
      and supported_isolation_drivers = array['do-harness-microvm']::text[]
      and isolation_class = 'provider-microvm'
      and jsonb_typeof(capabilities->'harnesses') = 'array'
      and jsonb_typeof(capabilities->'sizes') = 'array'
      and capabilities->'adapter'->>'version' = '2026.09.23.1')
  ) not valid;

alter table public.deployment_targets
  validate constraint deployment_targets_digitalocean_shape_check;

alter table public.hivra_agents
  drop constraint hivra_agents_computer_substrate_check,
  add constraint hivra_agents_computer_substrate_check
    check (computer_substrate in ('proxmox-kvm','provider-vm','gvisor','do-managed-session')),
  add column do_session_name text,
  add column do_session_id text,
  add column do_session_harness text,
  add column do_session_size text,
  add column do_launch_request_id uuid,
  add column do_session_observation jsonb,
  add column do_cleanup_receipt jsonb;

-- The substrate identity matrix is restated verbatim from
-- 20260915170000_hivra_gvisor_computers.sql with one added branch. The
-- DigitalOcean branch only fences the fields this matrix already owns; the
-- session-specific shape lives in hivra_agents_do_session_identity_check.
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
    or (computer_substrate='do-managed-session' and deployment_mode='self-managed' and vmid is null
      and provider_capacity_order_id is null and provider_enrollment_attempt_id is null
      and provider_server_id is null and gvisor_sandbox_id is null and gvisor_adapter_version is null
      and gvisor_adapter_sha256 is null and gvisor_runtime_sha256 is null)
  ) is true);

-- DigitalOcean identity only exists on DigitalOcean rows, and every other
-- substrate keeps the identity rules it already had.
alter table public.hivra_agents
  add constraint hivra_agents_do_session_identity_check check ((
    (computer_substrate <> 'do-managed-session'
      and do_session_name is null and do_session_id is null and do_session_harness is null
      and do_session_size is null and do_launch_request_id is null
      and do_session_observation is null and do_cleanup_receipt is null)
    or (computer_substrate = 'do-managed-session'
      and deployment_mode = 'self-managed' and vmid is null
      and provider_capacity_order_id is null and provider_enrollment_attempt_id is null
      and provider_server_id is null and gvisor_sandbox_id is null
      and computer_profile is null
      and infrastructure_binding_token_enforced is true
      and do_launch_request_id is not null
      -- Deterministic per agent so a lost create response is reconciled by
      -- name instead of creating a second billable session.
      and do_session_name = 'hivra-' || replace(id::text, '-', '')
      and (do_session_id is null or do_session_id ~ '^[A-Za-z0-9_.:-]{1,128}$')
      and ((do_session_harness = 'claude-code' and type = 'claude-code')
        or (do_session_harness = 'codex' and type = 'codex')
        or (do_session_harness = 'hermes' and type = 'hermes'))
      and do_session_size in ('mars-1vcpu-1gb','mars-2vcpu-2gb','mars-2vcpu-4gb','mars-4vcpu-8gb','mars-16vcpu-32gb')
      and (do_session_observation is null or jsonb_typeof(do_session_observation) = 'object')
      and (
        (status <> 'deleted' and do_cleanup_receipt is null
          and infrastructure_connection_id is not null and deployment_target_id is not null
          and infrastructure_connection_revision is not null)
        or (status = 'deleted' and infrastructure_connection_id is null
          and deployment_target_id is null and infrastructure_connection_revision is null
          and jsonb_typeof(do_cleanup_receipt) = 'object'
          and do_cleanup_receipt->>'state' in ('absent', 'never-created')
          and do_cleanup_receipt->>'sessionName' = do_session_name))
      and operation_id is null)
  ) is true);

create unique index hivra_agents_do_launch_request_unique
  on public.hivra_agents (user_id, do_launch_request_id)
  where computer_substrate = 'do-managed-session';

create unique index hivra_agents_do_session_name_unique
  on public.hivra_agents (do_session_name)
  where computer_substrate = 'do-managed-session';

-- The DigitalOcean row is born bound to a ready connection and target at the
-- exact evidence revision, keeps that binding immutable, and releases it only
-- together with a cleanup receipt naming the session that no longer exists.
create or replace function public.guard_hivra_do_managed_session()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op <> 'INSERT' and old.computer_substrate = 'do-managed-session' then
    if tg_op = 'DELETE' then
      raise exception 'Retain DigitalOcean session lifecycle evidence' using errcode = '55006';
    end if;
    if row(new.id, new.user_id, new.type, new.computer_substrate, new.deployment_mode, new.proxmox_host,
        new.do_session_name, new.do_session_harness, new.do_session_size, new.do_launch_request_id,
        new.infrastructure_binding_token_hash, new.infrastructure_binding_token_enforced)
      is distinct from row(old.id, old.user_id, old.type, old.computer_substrate, old.deployment_mode, old.proxmox_host,
        old.do_session_name, old.do_session_harness, old.do_session_size, old.do_launch_request_id,
        old.infrastructure_binding_token_hash, old.infrastructure_binding_token_enforced) then
      raise exception 'DigitalOcean session identity is immutable' using errcode = '55006';
    end if;
    if old.do_session_id is not null and new.do_session_id is distinct from old.do_session_id then
      raise exception 'A DigitalOcean session id cannot be rebound' using errcode = '55006';
    end if;
    if old.status = 'deleted' and new.status <> 'deleted' then
      raise exception 'A deleted DigitalOcean session cannot be reused' using errcode = '55006';
    end if;
    if new.status = 'deleted' and old.status <> 'deleted' then
      if new.do_cleanup_receipt->'binding'->>'connectionId' is distinct from old.infrastructure_connection_id::text
        or new.do_cleanup_receipt->'binding'->>'targetId' is distinct from old.deployment_target_id::text
        or new.do_cleanup_receipt->'binding'->>'connectionRevision'
          is distinct from old.infrastructure_connection_revision::text
        or (old.do_session_id is not null
          and new.do_cleanup_receipt->>'sessionId' is distinct from old.do_session_id) then
        raise exception 'DigitalOcean cleanup receipt does not match the bound session' using errcode = '55006';
      end if;
      return new;
    end if;
    if row(new.infrastructure_connection_id, new.deployment_target_id, new.infrastructure_connection_revision)
      is distinct from row(old.infrastructure_connection_id, old.deployment_target_id, old.infrastructure_connection_revision) then
      raise exception 'DigitalOcean session binding cannot move' using errcode = '55006';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  if new.computer_substrate <> 'do-managed-session' then return new; end if;
  if tg_op <> 'INSERT' then
    raise exception 'An existing agent cannot become a DigitalOcean session' using errcode = '55006';
  end if;
  if new.status <> 'provisioning' or new.desired_state <> 'running'
    or new.do_session_id is not null
    or new.proxmox_host <> '__hivra_self_managed_no_ambient_authority__' then
    raise exception 'DigitalOcean launch requires a canonical provisioning reservation' using errcode = '23514';
  end if;
  perform 1
  from public.deployment_targets t
  join public.infrastructure_connections c on c.id = t.connection_id and c.user_id = t.user_id
  where t.id = new.deployment_target_id and t.user_id = new.user_id
    and t.connection_id = new.infrastructure_connection_id
    and t.evidence_connection_revision = new.infrastructure_connection_revision
    and t.status = 'ready' and t.isolation_class = 'provider-microvm'
    and t.supported_isolation_drivers = array['do-harness-microvm']::text[]
    and t.capabilities->>'kind' = 'digitalocean-managed-agents'
    and t.capabilities->>'launchReady' = 'true'
    and t.capabilities->'harnesses' ? new.do_session_harness
    and t.capabilities->'sizes' ? new.do_session_size
    and c.provider = 'digitalocean' and c.status = 'ready'
    and c.revision = new.infrastructure_connection_revision
  for share of t, c;
  if not found then
    raise exception 'DigitalOcean target authority is unavailable' using errcode = '55006';
  end if;
  return new;
end;
$$;

create trigger hivra_do_managed_session_guard
  before insert or delete or update on public.hivra_agents
  for each row execute function public.guard_hivra_do_managed_session();

revoke all on function public.guard_hivra_do_managed_session() from public, anon, authenticated;

-- DigitalOcean's session event log carries the agent's output but not the
-- user's own prompt. Hivra records each prompt it forwarded against the run id
-- DigitalOcean returned, so a reloaded transcript shows what was asked.
create table if not exists public.hivra_do_session_inputs (
  id          uuid        primary key default gen_random_uuid(),
  agent_id    uuid        not null references public.hivra_agents (id) on delete restrict,
  user_id     text        not null check (btrim(user_id) <> ''),
  run_id      text        not null check (run_id ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  text        text        not null check (char_length(text) between 1 and 32768),
  created_at  timestamptz not null default now(),
  constraint hivra_do_session_inputs_run_key unique (agent_id, run_id)
);

create index if not exists hivra_do_session_inputs_agent_created_idx
  on public.hivra_do_session_inputs (agent_id, created_at desc);

alter table public.hivra_do_session_inputs enable row level security;
revoke all on public.hivra_do_session_inputs from public, anon, authenticated;
grant all on public.hivra_do_session_inputs to service_role;

-- Create the connection, its encrypted token envelope and its single target in
-- one transaction, with the caller-chosen id the envelope is bound to.
create or replace function public.create_digitalocean_infrastructure_connection(
  p_connection_id uuid,
  p_user_id text,
  p_name text,
  p_encrypted_bundle text,
  p_key_version smallint,
  p_checked_at timestamptz,
  p_target jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_target public.deployment_targets%rowtype;
begin
  if p_key_version <> 2 then
    raise exception 'DigitalOcean credentials require the bound envelope' using errcode = '22023';
  end if;
  if jsonb_typeof(p_target) <> 'object'
    or jsonb_typeof(p_target->'capabilities') <> 'object'
    or jsonb_typeof(p_target->'capacity') <> 'object' then
    raise exception 'DigitalOcean target evidence must be an object' using errcode = '22023';
  end if;

  insert into public.infrastructure_connections (
    id, user_id, name, provider, operating_mode, setup_mode, status,
    ssh_host, ssh_port, ssh_user, ssh_host_fingerprint_sha256,
    config, last_checked_at, last_error_code
  ) values (
    p_connection_id, p_user_id, p_name, 'digitalocean', 'self-managed', 'simple', 'ready',
    null, null, null, null,
    '{}'::jsonb, p_checked_at, null
  )
  returning * into v_connection;

  insert into public.infrastructure_connection_secrets (
    connection_id, user_id, encrypted_bundle, key_version
  ) values (
    v_connection.id, p_user_id, p_encrypted_bundle, p_key_version
  );

  insert into public.deployment_targets (
    user_id, connection_id, evidence_connection_revision, external_id, display_name,
    status, capacity, capabilities, supported_isolation_drivers, isolation_class,
    last_preflight_at, last_error_code
  ) values (
    p_user_id, v_connection.id, v_connection.revision, 'do-harness-runtime',
    'DigitalOcean Managed Agents', 'ready', p_target->'capacity', p_target->'capabilities',
    array['do-harness-microvm']::text[], 'provider-microvm', p_checked_at, null
  )
  returning * into v_target;

  return jsonb_build_object('connection', to_jsonb(v_connection), 'target', to_jsonb(v_target));
end;
$$;

-- Refresh the published evidence after re-validating the stored token. A
-- failed validation withdraws launch authority without touching sessions.
create or replace function public.refresh_digitalocean_infrastructure_target(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_checked_at timestamptz,
  p_target jsonb,
  p_error_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_target public.deployment_targets%rowtype;
begin
  select * into v_connection from public.infrastructure_connections
  where id = p_connection_id and user_id = p_user_id and provider = 'digitalocean'
    and revision = p_expected_revision
  for update;
  if not found then return null; end if;

  if p_error_code is not null then
    update public.infrastructure_connections
      set status = 'error', last_checked_at = p_checked_at, last_error_code = p_error_code
      where id = v_connection.id returning * into v_connection;
    update public.deployment_targets
      set status = 'unavailable',
          capabilities = jsonb_set(capabilities, '{launchReady}', 'false'::jsonb, true),
          last_preflight_at = p_checked_at, last_error_code = p_error_code
      where connection_id = v_connection.id and user_id = p_user_id
      returning * into v_target;
  else
    if jsonb_typeof(p_target->'capabilities') <> 'object' or jsonb_typeof(p_target->'capacity') <> 'object' then
      raise exception 'DigitalOcean target evidence must be an object' using errcode = '22023';
    end if;
    update public.infrastructure_connections
      set status = 'ready', last_checked_at = p_checked_at, last_error_code = null
      where id = v_connection.id returning * into v_connection;
    update public.deployment_targets
      set status = 'ready', capabilities = p_target->'capabilities', capacity = p_target->'capacity',
          last_preflight_at = p_checked_at, last_error_code = null
      where connection_id = v_connection.id and user_id = p_user_id
        and evidence_connection_revision = v_connection.revision
      returning * into v_target;
  end if;

  return jsonb_build_object('connection', to_jsonb(v_connection), 'target', to_jsonb(v_target));
end;
$$;

revoke all on function public.create_digitalocean_infrastructure_connection(uuid, text, text, text, smallint, timestamptz, jsonb)
  from public, anon, authenticated;
grant execute on function public.create_digitalocean_infrastructure_connection(uuid, text, text, text, smallint, timestamptz, jsonb)
  to service_role;
revoke all on function public.refresh_digitalocean_infrastructure_target(text, uuid, bigint, timestamptz, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.refresh_digitalocean_infrastructure_target(text, uuid, bigint, timestamptz, jsonb, text)
  to service_role;

comment on column public.hivra_agents.do_session_name is
  'Deterministic DigitalOcean harness session name (hivra-<agent id>). Reconciliation looks a lost create up by this name before creating again.';
comment on column public.hivra_agents.do_session_id is
  'Server-assigned DigitalOcean session id, bound once from the create or reconcile response.';
