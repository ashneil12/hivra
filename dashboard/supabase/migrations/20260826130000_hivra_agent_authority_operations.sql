-- Make Hivra agent infrastructure authority explicit and give every provider
-- mutation a durable desired-state / operation-id compare-and-swap contract.
--
-- This follows 20260826120000_portable_hivra_target_bindings.sql. It is kept in
-- a separate append-only migration so already-recorded migration history is not
-- rewritten.

alter table public.infrastructure_connections
  add column if not exists preflight_lease_expires_at timestamptz,
  add column if not exists pending_binding_rebind_from_revision bigint;

update public.infrastructure_connections
set preflight_lease_expires_at = coalesce(last_checked_at, now()) + interval '10 minutes'
where preflight_run_id is not null
  and preflight_lease_expires_at is null;

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_preflight_lease_shape_check,
  add constraint infrastructure_connections_preflight_lease_shape_check
    check (
      (preflight_run_id is null and preflight_lease_expires_at is null)
      or
      (preflight_run_id is not null and preflight_lease_expires_at is not null)
    ) not valid;
alter table public.infrastructure_connections
  validate constraint infrastructure_connections_preflight_lease_shape_check;

alter table public.hivra_agents
  add column if not exists deployment_mode text,
  add column if not exists desired_state text,
  add column if not exists operation_id uuid,
  add column if not exists operation_kind text,
  add column if not exists operation_started_at timestamptz,
  add column if not exists operation_payload jsonb,
  add column if not exists allocation_operation_id uuid,
  add column if not exists infrastructure_binding_token_hash text,
  add column if not exists infrastructure_binding_token_enforced boolean;

-- N-1 managed writers do not stamp a provider binding tag. Give their rows an
-- unguessable pending token for guarded managed-fleet adoption, while current
-- writers explicitly set enforcement true and stamp the matching provider tag
-- before publishing a VM identity.
update public.hivra_agents
set infrastructure_binding_token_hash = encode(
      digest(gen_random_uuid()::text, 'sha256'),
      'hex'
    )
where infrastructure_binding_token_hash is null;

update public.hivra_agents
set infrastructure_binding_token_enforced = false
where infrastructure_binding_token_enforced is null;

-- Legacy rows are managed. A row carrying the complete portable binding from
-- the preceding migration is self-managed. The sentinel is deliberately not a
-- real Proxmox node name: an N-1 application that ignores deployment_mode must
-- fail target-specific credential resolution instead of falling back to an
-- ambient managed-fleet host.
update public.hivra_agents
set deployment_mode = case
  when infrastructure_connection_id is not null
    and deployment_target_id is not null
    and infrastructure_connection_revision is not null
    then 'self-managed'
  else 'hivra-managed'
end
where deployment_mode is null;

update public.hivra_agents
set proxmox_host = '__hivra_self_managed_no_ambient_authority__'
where deployment_mode = 'self-managed';

-- Deleted portable rows no longer own provider authority. Clear their binding
-- before validating the authority matrix so historical tombstones do not keep
-- connections undeletable forever.
update public.hivra_agents
set infrastructure_connection_id = null,
    deployment_target_id = null,
    infrastructure_connection_revision = null
where deployment_mode = 'self-managed'
  and status = 'deleted';

update public.hivra_agents
set desired_state = case
  when status = 'deleted' then 'deleted'
  when status = 'stopped' then 'stopped'
  else 'running'
end
where desired_state is null;

-- Preserve an in-flight provision across the migration/app rollout boundary.
-- The new GET/DELETE handlers can then CAS or compensate it instead of treating
-- it as an unleased provider mutation.
update public.hivra_agents
set operation_id = gen_random_uuid(),
    operation_kind = 'provision',
    operation_started_at = coalesce(created_at, now()),
    operation_payload = jsonb_build_object('compatibility', 'n_minus_one')
where status = 'provisioning'
  and operation_id is null;

alter table public.hivra_agents
  -- Expand/contract rollout: N-1 managed-only writers omit this new column.
  -- Keep a temporary managed default for migration-first deploy and rollback;
  -- current POST code still sends an explicit mode. Remove the default in a
  -- later cleanup migration after N-1 is outside the rollback window.
  alter column deployment_mode set default 'hivra-managed',
  alter column deployment_mode set not null,
  alter column desired_state set default 'running',
  alter column desired_state set not null,
  alter column infrastructure_binding_token_hash set default encode(
    digest(gen_random_uuid()::text, 'sha256'),
    'hex'
  ),
  alter column infrastructure_binding_token_hash set not null,
  alter column infrastructure_binding_token_enforced set default false,
  alter column infrastructure_binding_token_enforced set not null;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_binding_token_hash_check,
  add constraint hivra_agents_binding_token_hash_check
    check (infrastructure_binding_token_hash ~ '^[0-9a-f]{64}$') not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_binding_token_hash_check;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_deployment_mode_check,
  add constraint hivra_agents_deployment_mode_check
    check (deployment_mode in ('hivra-managed', 'self-managed')) not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_deployment_mode_check;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_desired_state_check,
  add constraint hivra_agents_desired_state_check
    check (desired_state in ('running', 'stopped', 'deleted')) not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_desired_state_check;

alter table public.hivra_agents
  drop constraint if exists hivra_agents_operation_shape_check,
  add constraint hivra_agents_operation_shape_check
    check (
      (
        operation_id is null
        and operation_kind is null
        and operation_started_at is null
        and operation_payload is null
      )
      or
      (
        operation_id is not null
        and operation_kind in ('provision', 'start', 'stop', 'restart', 'resize', 'delete')
        and operation_started_at is not null
        and (operation_payload is null or jsonb_typeof(operation_payload) = 'object')
      )
    ) not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_operation_shape_check;

-- Active self-managed rows must retain their exact owner/connection/target/
-- revision binding. A verified terminal delete releases that binding so the
-- user can later delete the infrastructure connection without converting the
-- historical row into managed authority.
alter table public.hivra_agents
  drop constraint if exists hivra_agents_deployment_authority_matrix_check,
  add constraint hivra_agents_deployment_authority_matrix_check
    check (
      (
        deployment_mode = 'hivra-managed'
        and infrastructure_connection_id is null
        and deployment_target_id is null
        and infrastructure_connection_revision is null
        and proxmox_host <> '__hivra_self_managed_no_ambient_authority__'
      )
      or
      (
        deployment_mode = 'self-managed'
        and proxmox_host = '__hivra_self_managed_no_ambient_authority__'
        and (
          (
            status <> 'deleted'
            and infrastructure_binding_token_enforced
            and infrastructure_connection_id is not null
            and deployment_target_id is not null
            and infrastructure_connection_revision is not null
          )
          or
          (
            status = 'deleted'
            and infrastructure_connection_id is null
            and deployment_target_id is null
            and infrastructure_connection_revision is null
          )
        )
      )
    ) not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_deployment_authority_matrix_check;

-- Migration-first expand compatibility for the managed-only N-1 application.
-- Old INSERTs omit the new operation fields; give their provisioning work a
-- durable lease. Old terminal poll updates may clear only that provision lease,
-- and never after a newer delete request changed desired_state.
create or replace function public.normalize_hivra_agent_operation_compatibility()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT'
    and new.deployment_mode = 'hivra-managed'
    and new.status = 'provisioning'
    and new.operation_id is null
  then
    new.operation_id := gen_random_uuid();
    new.operation_kind := 'provision';
    new.operation_started_at := now();
    new.operation_payload := jsonb_build_object('compatibility', 'n_minus_one');
    new.desired_state := 'running';
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.deployment_mode = 'hivra-managed'
    and old.operation_id is null
    and new.operation_id is null
    and old.status in ('running', 'stopped', 'error')
    and new.status = 'provisioning'
  then
    new.operation_id := gen_random_uuid();
    new.operation_kind := 'start';
    new.operation_started_at := now();
    new.operation_payload := jsonb_build_object('compatibility', 'n_minus_one');
    new.desired_state := 'running';
    return new;
  end if;

  if tg_op = 'UPDATE'
    and old.deployment_mode = 'hivra-managed'
    and old.operation_kind in ('provision', 'start', 'restart', 'resize')
    and new.operation_id = old.operation_id
    and new.operation_kind = old.operation_kind
    and new.status in ('running', 'stopped', 'error', 'deleted')
  then
    if old.desired_state = 'deleted' and new.status <> 'deleted' then
      raise exception 'legacy provision result was superseded by delete'
        using errcode = '55000';
    end if;
    if new.status = 'deleted' then
      new.desired_state := 'deleted';
    end if;
    new.operation_id := null;
    new.operation_kind := null;
    new.operation_started_at := null;
    new.operation_payload := null;
  end if;

  return new;
end;
$$;

drop trigger if exists a_hivra_agents_operation_compatibility
  on public.hivra_agents;
create trigger a_hivra_agents_operation_compatibility
  before insert or update of status on public.hivra_agents
  for each row execute function public.normalize_hivra_agent_operation_compatibility();

-- Validate and serialize a portable binding against its authoritative
-- connection revision. FOR KEY SHARE makes a concurrent connection edit/delete
-- wait; once the insert commits, the update RPC below observes the live binding
-- and refuses the operational change.
create or replace function public.enforce_hivra_agent_deployment_authority()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection_revision bigint;
  v_connection_status text;
  v_connection_pending_rebind_from_revision bigint;
  v_target_revision bigint;
  v_target_status text;
  v_target_capabilities jsonb;
  v_target_isolation_class text;
  v_credential_recovery_completion boolean := false;
begin
  if new.deployment_mode = 'hivra-managed' then
    if new.infrastructure_connection_id is not null
      or new.deployment_target_id is not null
      or new.infrastructure_connection_revision is not null
      or new.proxmox_host = '__hivra_self_managed_no_ambient_authority__'
    then
      raise exception 'managed Hivra agent carries self-managed authority'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.deployment_mode <> 'self-managed' then
    raise exception 'Hivra deployment mode is invalid' using errcode = '23514';
  end if;
  if new.proxmox_host <> '__hivra_self_managed_no_ambient_authority__' then
    raise exception 'self-managed Hivra agent lacks rollback authority fuse'
      using errcode = '23514';
  end if;

  if new.status = 'deleted' then
    if new.infrastructure_connection_id is not null
      or new.deployment_target_id is not null
      or new.infrastructure_connection_revision is not null
    then
      raise exception 'deleted self-managed Hivra agent retained provider authority'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.infrastructure_connection_id is null
    or new.deployment_target_id is null
    or new.infrastructure_connection_revision is null
  then
    raise exception 'self-managed Hivra authority binding is incomplete'
      using errcode = '23514';
  end if;

  select revision, status, pending_binding_rebind_from_revision
  into
    v_connection_revision,
    v_connection_status,
    v_connection_pending_rebind_from_revision
  from public.infrastructure_connections
  where id = new.infrastructure_connection_id
    and user_id = new.user_id
  for key share;

  if not found then
    raise exception 'self-managed Hivra connection revision is stale or unavailable'
      using errcode = '55000';
  end if;

  -- Credential-only repair must be possible after an SSH key expires while a
  -- provider operation is stranded. The recovery RPC rotates only the secret,
  -- preserves endpoint/fingerprint/target identity, and records the exact N
  -- revision while readiness is revoked at N+1. Permit only that already-
  -- leased row to retain or clear its same operation during evidence-backed
  -- teardown reconciliation. New claims/launches remain blocked until a later
  -- successful preflight atomically rebinds the idle row to N+1.
  if tg_op = 'UPDATE' then
    v_credential_recovery_completion :=
      old.deployment_mode = 'self-managed'
      and old.operation_id is not null
      and (
        (
          new.operation_id is not distinct from old.operation_id
          and new.operation_kind is not distinct from old.operation_kind
        )
        or (new.operation_id is null and new.operation_kind is null)
      )
      and new.infrastructure_connection_id = old.infrastructure_connection_id
      and new.deployment_target_id = old.deployment_target_id
      and new.infrastructure_connection_revision = old.infrastructure_connection_revision
      and v_connection_pending_rebind_from_revision = old.infrastructure_connection_revision
      and v_connection_revision > old.infrastructure_connection_revision
      and v_connection_status in ('pending', 'error');
  end if;

  if not v_credential_recovery_completion
    and (
      v_connection_status <> 'ready'
      or v_connection_revision <> new.infrastructure_connection_revision
    )
  then
    raise exception 'self-managed Hivra connection revision is stale or unavailable'
      using errcode = '55000';
  end if;

  select evidence_connection_revision, status, capabilities, isolation_class
  into v_target_revision, v_target_status, v_target_capabilities, v_target_isolation_class
  from public.deployment_targets
  where id = new.deployment_target_id
    and connection_id = new.infrastructure_connection_id
    and user_id = new.user_id
  for key share;

  if not found
    or (
      v_credential_recovery_completion
      and v_target_revision <> old.infrastructure_connection_revision
    )
    or (
      not v_credential_recovery_completion
      and (
        v_target_revision <> new.infrastructure_connection_revision
        or v_target_status <> 'ready'
        or not coalesce(v_target_capabilities @> '{"launchReady": true}'::jsonb, false)
        or v_target_isolation_class <> 'hardware-vm'
      )
    )
  then
    raise exception 'self-managed Hivra deployment target evidence is stale or unavailable'
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists hivra_agents_deployment_authority_guard
  on public.hivra_agents;
create trigger hivra_agents_deployment_authority_guard
  before insert or update of
    user_id,
    status,
    deployment_mode,
    infrastructure_connection_id,
    deployment_target_id,
    infrastructure_connection_revision,
    proxmox_host
  on public.hivra_agents
  for each row execute function public.enforce_hivra_agent_deployment_authority();

-- Claim one provider operation. Portable claims re-check the durable revision
-- and target evidence while holding connection/target key-share locks, so an
-- edit, preflight invalidation, or connection delete cannot cross the claim.
create or replace function public.claim_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_operation_kind text,
  p_desired_state text,
  p_operation_payload jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_connection_revision bigint;
  v_connection_status text;
  v_target_revision bigint;
  v_target_status text;
  v_target_capabilities jsonb;
  v_target_isolation_class text;
begin
  if p_operation_id is null
    or p_operation_kind not in ('start', 'stop', 'restart', 'resize')
    or p_desired_state not in ('running', 'stopped')
  then
    raise exception 'invalid Hivra operation claim' using errcode = '22023';
  end if;
  if (
    p_operation_kind = 'resize'
    and (
      p_operation_payload is null
      or jsonb_typeof(p_operation_payload) <> 'object'
      or jsonb_typeof(p_operation_payload -> 'cpu') <> 'number'
      or jsonb_typeof(p_operation_payload -> 'ram') <> 'number'
      or (p_operation_payload ->> 'cpu')::numeric <= 0
      or (p_operation_payload ->> 'ram')::integer <= 0
    )
  ) or (
    p_operation_kind <> 'resize' and p_operation_payload is not null
  ) then
    raise exception 'invalid Hivra operation payload' using errcode = '22023';
  end if;

  select * into v_agent
  from public.hivra_agents
  where id = p_agent_id
    and user_id = p_user_id
  for update;

  if not found
    or v_agent.status = 'deleted'
    or v_agent.desired_state = 'deleted'
    or v_agent.operation_id is not null
  then
    return false;
  end if;

  if v_agent.deployment_mode = 'self-managed' then
    select revision, status
    into v_connection_revision, v_connection_status
    from public.infrastructure_connections
    where id = v_agent.infrastructure_connection_id
      and user_id = p_user_id
    for key share;

    if not found
      or v_connection_status <> 'ready'
      or v_connection_revision <> v_agent.infrastructure_connection_revision
    then
      return false;
    end if;

    select evidence_connection_revision, status, capabilities, isolation_class
    into v_target_revision, v_target_status, v_target_capabilities, v_target_isolation_class
    from public.deployment_targets
    where id = v_agent.deployment_target_id
      and connection_id = v_agent.infrastructure_connection_id
      and user_id = p_user_id
    for key share;

    if not found
      or v_target_status <> 'ready'
      or v_target_revision <> v_agent.infrastructure_connection_revision
      or not coalesce(v_target_capabilities @> '{"launchReady": true}'::jsonb, false)
      or v_target_isolation_class <> 'hardware-vm'
    then
      return false;
    end if;
  end if;

  update public.hivra_agents
  set desired_state = p_desired_state,
      operation_id = p_operation_id,
      operation_kind = p_operation_kind,
      operation_started_at = now(),
      operation_payload = p_operation_payload
  where id = p_agent_id
    and user_id = p_user_id;
  return true;
end;
$$;

-- A delete request immediately changes desired state but never steals an active
-- provider lease. In particular, an in-flight provision retains its operation
-- id so its owner can observe the changed desired state, verify/compensate any
-- allocation, and only then complete deletion with that same lease.
create or replace function public.request_hivra_agent_delete(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
begin
  if p_operation_id is null then
    raise exception 'delete operation id is required' using errcode = '22023';
  end if;

  select * into v_agent
  from public.hivra_agents
  where id = p_agent_id
    and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if v_agent.status = 'deleted' then return 'deleted'; end if;

  if v_agent.operation_id is not null then
    update public.hivra_agents
    set desired_state = 'deleted'
    where id = p_agent_id
      and user_id = p_user_id;
    return 'pending';
  end if;

  update public.hivra_agents
  set desired_state = 'deleted',
      operation_id = p_operation_id,
      operation_kind = 'delete',
      operation_started_at = now(),
      operation_payload = null
  where id = p_agent_id
    and user_id = p_user_id;
  return 'claimed';
end;
$$;

create or replace function public.checkpoint_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_expected_desired_state text
)
returns boolean
language sql
security invoker
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.hivra_agents
    where id = p_agent_id
      and user_id = p_user_id
      and operation_id = p_operation_id
      and desired_state = p_expected_desired_state
      and status <> 'deleted'
  );
$$;

-- One bounded crash reconciler may take over an abandoned operation without
-- changing its durable provider identity. The exact previous timestamp is a
-- second CAS token; renewing it prevents two cron/user retries from mutating
-- the same provider resource concurrently. All normal provider commands in
-- this release are bounded well below ten minutes.
create or replace function public.claim_hivra_agent_operation_recovery(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_expected_operation_started_at timestamptz,
  p_recovered_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  if p_expected_operation_started_at is null
    or p_recovered_at is null
    or p_recovered_at < p_expected_operation_started_at + interval '10 minutes'
  then
    return false;
  end if;

  update public.hivra_agents
  set operation_started_at = p_recovered_at
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
    and operation_started_at = p_expected_operation_started_at
    and operation_kind is not null
    and status <> 'deleted';
  v_updated := found;
  return v_updated;
end;
$$;

create or replace function public.persist_hivra_agent_provision_identity(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_vmid integer,
  p_ip text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.hivra_agents
  set vmid = p_vmid,
      ip = p_ip,
      allocation_operation_id = case
        when infrastructure_binding_token_enforced then p_operation_id
        else null
      end
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
    and operation_kind = 'provision'
    and desired_state in ('running', 'deleted')
    and status = 'provisioning';
  v_updated := found;
  return v_updated;
end;
$$;

create or replace function public.complete_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_expected_desired_state text,
  p_status text,
  p_cpu numeric,
  p_ram integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  if p_status not in ('running', 'stopped', 'error') then
    raise exception 'invalid synchronous Hivra operation completion status'
      using errcode = '22023';
  end if;
  update public.hivra_agents
  set status = p_status,
      desired_state = case
        when p_status = 'running' then 'running'
        when p_status = 'stopped' then 'stopped'
        else desired_state
      end,
      cpu = coalesce(p_cpu, cpu),
      ram = coalesce(p_ram, ram),
      error = null,
      operation_id = null,
      operation_kind = null,
      operation_started_at = null,
      operation_payload = null
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
    and desired_state = p_expected_desired_state
    and (
      operation_kind <> 'resize'
      or (p_cpu is null and p_ram is null)
      or (
        (operation_payload ->> 'cpu')::numeric = p_cpu
        and (operation_payload ->> 'ram')::integer = p_ram
      )
    )
    and status <> 'deleted';
  v_updated := found;
  return v_updated;
end;
$$;

-- Mark an asynchronous start-like operation as converging without releasing its
-- lease. GET owns the terminal host-result CAS for provision/start/restart/resize.
create or replace function public.continue_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_expected_desired_state text,
  p_status text,
  p_cpu numeric,
  p_ram integer
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.hivra_agents
  set status = p_status,
      cpu = coalesce(p_cpu, cpu),
      ram = coalesce(p_ram, ram),
      error = null
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
      and operation_kind in ('start', 'restart', 'resize')
      and desired_state = p_expected_desired_state
      and (
        operation_kind <> 'resize'
        or (
          (operation_payload ->> 'cpu')::numeric = p_cpu
          and (operation_payload ->> 'ram')::integer = p_ram
        )
      )
    and status <> 'deleted';
  v_updated := found;
  return v_updated;
end;
$$;

-- Running convergence carries provider output (and, for first provision, a
-- secret bearer), so it has a dedicated CAS instead of a read-then-update in
-- the polling route. A concurrent delete changes desired_state and makes this
-- update a no-op.
create or replace function public.complete_hivra_agent_running(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_operation_kind text,
  p_chat_url text,
  p_ip text,
  p_api_token text,
  p_provisioned_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  if p_operation_kind not in ('provision', 'start', 'restart', 'resize') then
    raise exception 'invalid running convergence operation' using errcode = '22023';
  end if;

  update public.hivra_agents
  set status = 'running',
      chat_url = p_chat_url,
      ip = coalesce(p_ip, ip),
      api_token = coalesce(p_api_token, api_token),
      provisioned_at = coalesce(provisioned_at, p_provisioned_at),
      error = null,
      operation_id = null,
      operation_kind = null,
      operation_started_at = null,
      operation_payload = null
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
    and operation_kind = p_operation_kind
    and desired_state = 'running'
    and status = 'provisioning';
  v_updated := found;
  return v_updated;
end;
$$;

create or replace function public.release_hivra_agent_operation(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_error text,
  p_mark_error boolean
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.hivra_agents
  set status = case
        when p_mark_error and desired_state <> 'deleted' then 'error'
        else status
      end,
      error = case
        when p_mark_error then left(coalesce(p_error, 'operation failed'), 300)
        else error
      end,
      operation_id = null,
      operation_kind = null,
      operation_started_at = null,
      operation_payload = null
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id;
  v_updated := found;
  return v_updated;
end;
$$;

-- An allocation command can lose its transport before returning a VMID. Keep
-- the provision lease and operation-tag identity durable until recovery proves
-- provider absence or destroys the matching VM.
create or replace function public.record_hivra_agent_operation_failure(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.hivra_agents
  set error = left(coalesce(p_error, 'provider operation outcome is unknown'), 300)
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id;
  v_updated := found;
  return v_updated;
end;
$$;

-- Used after either a claimed delete or a provision operation that observed a
-- concurrent delete request and successfully compensated its allocated VM.
create or replace function public.complete_hivra_agent_delete(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.hivra_agents
  set status = 'deleted',
      desired_state = 'deleted',
      operation_id = null,
      operation_kind = null,
      operation_started_at = null,
      operation_payload = null,
      infrastructure_connection_id = null,
      deployment_target_id = null,
      infrastructure_connection_revision = null,
      allocation_operation_id = null,
      vmid = null,
      ip = null,
      chat_url = null,
      api_token = null,
      cf_tunnel_id = null,
      cf_hostname = null,
      error = null
  where id = p_agent_id
    and user_id = p_user_id
    and operation_id = p_operation_id
    and operation_kind in ('delete', 'provision')
    and desired_state = 'deleted';
  v_updated := found;
  return v_updated;
end;
$$;

-- Operational edits rotate provider authority. They are forbidden while any
-- non-deleted portable agent remains bound. Name-only metadata updates remain
-- available; verified agent deletion releases the binding above.
create or replace function public.update_infrastructure_connection(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_patch jsonb,
  p_operational_change boolean,
  p_rotate_credentials boolean,
  p_encrypted_bundle text,
  p_key_version smallint
)
returns setof public.infrastructure_connections
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;

  if not found then return; end if;

  if v_connection.preflight_run_id is not null then
    raise exception 'infrastructure connection has an active preparation or preflight lease'
      using errcode = '55006';
  end if;

  if p_rotate_credentials and not p_operational_change then
    raise exception 'credential rotation must be operational'
      using errcode = '22023';
  end if;
  if not p_operational_change
    and (coalesce(p_patch, '{}'::jsonb) - 'name') <> '{}'::jsonb
  then
    raise exception 'non-operational connection update may only change name'
      using errcode = '22023';
  end if;
  if p_operational_change and exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and deployment_mode = 'self-managed'
      and status <> 'deleted'
  ) then
    raise exception 'infrastructure connection is bound to active Hivra agents'
      using errcode = '55006';
  end if;

  update public.infrastructure_connections
  set
    name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
    setup_mode = case when p_patch ? 'setup_mode' then p_patch ->> 'setup_mode' else setup_mode end,
    ssh_host = case when p_patch ? 'ssh_host' then p_patch ->> 'ssh_host' else ssh_host end,
    ssh_port = case when p_patch ? 'ssh_port' then (p_patch ->> 'ssh_port')::integer else ssh_port end,
    ssh_user = case when p_patch ? 'ssh_user' then p_patch ->> 'ssh_user' else ssh_user end,
    ssh_host_fingerprint_sha256 = case
      when p_patch ? 'ssh_host_fingerprint_sha256'
        then p_patch ->> 'ssh_host_fingerprint_sha256'
      else ssh_host_fingerprint_sha256
    end,
    config = case when p_patch ? 'config' then p_patch -> 'config' else config end,
    status = case when p_operational_change then 'pending' else status end,
    preflight_run_id = case when p_operational_change then null else preflight_run_id end,
    last_checked_at = case when p_operational_change then null else last_checked_at end,
    last_error_code = case when p_operational_change then null else last_error_code end,
    revision = case when p_operational_change then revision + 1 else revision end
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  returning * into v_connection;

  if p_rotate_credentials then
    update public.infrastructure_connection_secrets
    set encrypted_bundle = p_encrypted_bundle,
        key_version = p_key_version
    where connection_id = p_connection_id
      and user_id = p_user_id;
    if not found then
      raise exception 'infrastructure credential row missing' using errcode = 'P0002';
    end if;
  end if;

  if p_operational_change then
    update public.deployment_targets
    set status = 'unavailable',
        capabilities = jsonb_set(
          coalesce(capabilities, '{}'::jsonb),
          '{launchReady}',
          'false'::jsonb,
          true
        ),
        supported_isolation_drivers = '{}'::text[],
        isolation_class = null,
        last_error_code = 'PREFLIGHT_SUPERSEDED'
    where connection_id = p_connection_id
      and user_id = p_user_id;
  elsif p_patch ? 'name' then
    update public.deployment_targets
    set display_name = left(v_connection.name || ' / ' || external_id, 128)
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return next v_connection;
end;
$$;

-- Credential-only recovery preserves endpoint/fingerprint/target identity. It
-- serializes against provider operations, rotates only the encrypted key,
-- revokes readiness, and records the old bound revision for atomic rebind after
-- a successful preflight.
create or replace function public.recover_infrastructure_connection_credentials(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_encrypted_bundle text,
  p_key_version smallint
)
returns setof public.infrastructure_connections
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_has_bindings boolean := false;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return; end if;

  if v_connection.preflight_run_id is not null then
    raise exception 'infrastructure connection has an active preparation or preflight lease'
      using errcode = '55006';
  end if;
  if exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and operation_id is not null
      and (
        operation_started_at is null
        or operation_started_at > now() - interval '10 minutes'
      )
      and status <> 'deleted'
  ) then
    raise exception 'infrastructure connection has a fresh Hivra operation'
      using errcode = '55006';
  end if;

  select exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and deployment_mode = 'self-managed'
      and status <> 'deleted'
  ) into v_has_bindings;

  update public.infrastructure_connection_secrets
  set encrypted_bundle = p_encrypted_bundle,
      key_version = p_key_version
  where connection_id = p_connection_id
    and user_id = p_user_id;
  if not found then
    raise exception 'infrastructure credential row missing' using errcode = 'P0002';
  end if;

  update public.infrastructure_connections
  set revision = revision + 1,
      status = 'pending',
      preflight_run_id = null,
      preflight_lease_expires_at = null,
      last_checked_at = null,
      last_error_code = null,
      pending_binding_rebind_from_revision = case
        when v_has_bindings
          then coalesce(pending_binding_rebind_from_revision, p_expected_revision)
        else null
      end
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  returning * into v_connection;

  update public.deployment_targets
  set status = 'unavailable',
      capabilities = jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      supported_isolation_drivers = '{}'::text[],
      isolation_class = null,
      last_error_code = 'PREFLIGHT_SUPERSEDED'
  where connection_id = p_connection_id
    and user_id = p_user_id;

  return next v_connection;
end;
$$;

-- Replace the preflight completion body so lease expiry is cleared and a
-- credential-recovery revision is rebound to every idle live agent only after
-- ready evidence for the same immutable target identity is persisted.
create or replace function public.complete_infrastructure_connection_preflight(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid,
  p_connection_status text,
  p_checked_at timestamptz,
  p_last_error_code text,
  p_target jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_rebind_from bigint;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
    and preflight_run_id = p_run_id
  for update;
  if not found then return false; end if;
  if p_connection_status = 'ready' and p_target is null then return false; end if;

  update public.deployment_targets
  set status = 'unavailable',
      capabilities = jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      supported_isolation_drivers = '{}'::text[],
      isolation_class = null,
      last_error_code = coalesce(p_last_error_code, 'PREFLIGHT_SUPERSEDED')
  where connection_id = p_connection_id
    and user_id = p_user_id;

  if p_target is not null then
    insert into public.deployment_targets (
      user_id, connection_id, external_id, display_name, status, capacity,
      capabilities, supported_isolation_drivers, isolation_class,
      last_preflight_at, last_error_code, evidence_connection_revision
    ) values (
      p_user_id,
      p_connection_id,
      p_target ->> 'externalId',
      left(v_connection.name || ' / ' || (p_target ->> 'externalId'), 128),
      p_target ->> 'status',
      coalesce(p_target -> 'capacity', '{}'::jsonb),
      coalesce(p_target -> 'capabilities', '{}'::jsonb),
      coalesce(
        array(select jsonb_array_elements_text(p_target -> 'supportedIsolationDrivers')),
        '{}'::text[]
      ),
      nullif(p_target ->> 'isolationClass', ''),
      p_checked_at,
      p_target ->> 'lastErrorCode',
      p_expected_revision
    )
    on conflict (connection_id, external_id) do update
    set user_id = excluded.user_id,
        display_name = excluded.display_name,
        status = excluded.status,
        capacity = excluded.capacity,
        capabilities = excluded.capabilities,
        supported_isolation_drivers = excluded.supported_isolation_drivers,
        isolation_class = excluded.isolation_class,
        last_preflight_at = excluded.last_preflight_at,
        last_error_code = excluded.last_error_code,
        evidence_connection_revision = excluded.evidence_connection_revision;
  end if;

  v_rebind_from := v_connection.pending_binding_rebind_from_revision;
  update public.infrastructure_connections
  set status = p_connection_status,
      preflight_run_id = null,
      preflight_lease_expires_at = null,
      last_checked_at = p_checked_at,
      last_error_code = p_last_error_code
  where id = p_connection_id
    and user_id = p_user_id;

  if p_connection_status = 'ready' and v_rebind_from is not null then
    update public.hivra_agents
    set infrastructure_connection_revision = p_expected_revision
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and deployment_mode = 'self-managed'
      and status <> 'deleted'
      and infrastructure_connection_revision = v_rebind_from;

    if exists (
      select 1
      from public.hivra_agents
      where infrastructure_connection_id = p_connection_id
        and user_id = p_user_id
        and deployment_mode = 'self-managed'
        and status <> 'deleted'
        and infrastructure_connection_revision <> p_expected_revision
    ) then
      raise exception 'not all Hivra bindings could be rebound safely'
        using errcode = '55000';
    end if;

    update public.infrastructure_connections
    set pending_binding_rebind_from_revision = null
    where id = p_connection_id
      and user_id = p_user_id;
  end if;

  return true;
end;
$$;

-- Claim one durable lease before Simple preparation mutates the remote host.
-- The connection row lock serializes with launch/operation key-share locks;
-- readiness is revoked in the same transaction, before any SSH command runs.
create or replace function public.begin_infrastructure_connection_preparation(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid,
  p_started_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return false; end if;

  if v_connection.preflight_run_id is not null
    and v_connection.preflight_run_id <> p_run_id
  then
    -- Migration-first / rollback compatibility: N-1 callers cannot name the
    -- observed lease owner. Under this row lock, replace it only after the
    -- durable ten-minute lease (well beyond the bounded remote command) is
    -- definitively expired. Fresh owners still win and return false.
    if v_connection.preflight_lease_expires_at is null
      or v_connection.preflight_lease_expires_at >= p_started_at
    then
      return false;
    end if;
  end if;

  if exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and status <> 'deleted'
  ) then
    return false;
  end if;

  update public.infrastructure_connections
  set status = 'checking',
      preflight_run_id = p_run_id,
      preflight_lease_expires_at = p_started_at + interval '10 minutes',
      last_checked_at = p_started_at,
      last_error_code = null
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision;

  update public.deployment_targets
  set status = 'unavailable',
      capabilities = jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      supported_isolation_drivers = '{}'::text[],
      isolation_class = null,
      last_error_code = 'PREFLIGHT_SUPERSEDED'
  where connection_id = p_connection_id
    and user_id = p_user_id;

  return true;
end;
$$;

-- Do not invalidate target evidence underneath an active provider operation.
-- Idle bound agents may still be re-checked because the revision and immutable
-- target identity do not change. A preparation flow transfers its existing
-- run id into preflight, so there is no ready/lease gap between remote mutation
-- and read-only verification.
create or replace function public.begin_infrastructure_connection_preflight(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid,
  p_started_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return false; end if;

  if v_connection.preflight_run_id is not null
    and v_connection.preflight_run_id <> p_run_id
  then
    if v_connection.preflight_lease_expires_at is null
      or v_connection.preflight_lease_expires_at >= p_started_at
    then
      return false;
    end if;
  end if;

  if exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and operation_id is not null
      and status <> 'deleted'
  ) then
    return false;
  end if;

  update public.infrastructure_connections
  set status = 'checking',
      preflight_run_id = p_run_id,
      preflight_lease_expires_at = p_started_at + interval '10 minutes',
      last_checked_at = p_started_at,
      last_error_code = null
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision;
  if not found then return false; end if;

  update public.deployment_targets
  set status = 'unavailable',
      capabilities = jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      supported_isolation_drivers = '{}'::text[],
      isolation_class = null,
      last_error_code = 'PREFLIGHT_SUPERSEDED'
  where connection_id = p_connection_id
    and user_id = p_user_id;

  return true;
end;
$$;

-- Credential/decryption invalidation happens before a run lease is claimed.
-- Never let that path clear a concurrent preparation/preflight owner.
create or replace function public.invalidate_infrastructure_connection_preflight(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_checked_at timestamptz,
  p_last_error_code text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
    and preflight_run_id is null
  for update;
  if not found then return false; end if;

  if exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and operation_id is not null
      and status <> 'deleted'
  ) then
    return false;
  end if;

  update public.infrastructure_connections
  set status = 'error',
      preflight_lease_expires_at = null,
      last_checked_at = p_checked_at,
      last_error_code = p_last_error_code
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
    and preflight_run_id is null;
  v_updated := found;

  if v_updated then
    update public.deployment_targets
    set status = 'unavailable',
        capabilities = jsonb_set(
          coalesce(capabilities, '{}'::jsonb),
          '{launchReady}',
          'false'::jsonb,
          true
        ),
        supported_isolation_drivers = '{}'::text[],
        isolation_class = null,
        last_error_code = p_last_error_code
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return v_updated;
end;
$$;

-- Expired leases are never taken over implicitly. Recovery names the exact
-- observed owner and revision, then atomically proves expiry before clearing it.
create or replace function public.recover_expired_infrastructure_connection_run(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_expected_run_id uuid,
  p_recovered_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.infrastructure_connections
  set status = 'error',
      preflight_run_id = null,
      preflight_lease_expires_at = null,
      last_checked_at = p_recovered_at,
      last_error_code = 'PREFLIGHT_SUPERSEDED'
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
    and preflight_run_id = p_expected_run_id
    and preflight_lease_expires_at < p_recovered_at;
  v_updated := found;

  if v_updated then
    update public.deployment_targets
    set status = 'unavailable',
        capabilities = jsonb_set(
          coalesce(capabilities, '{}'::jsonb),
          '{launchReady}',
          'false'::jsonb,
          true
        ),
        supported_isolation_drivers = '{}'::text[],
        isolation_class = null,
        last_error_code = 'PREFLIGHT_SUPERSEDED'
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return v_updated;
end;
$$;

-- Direct connection deletion must serialize with preparation/preflight too.
-- Foreign keys already protect live agent bindings; this trigger closes the
-- no-binding host-mutation race that a plain DELETE would otherwise cross.
create or replace function public.enforce_infrastructure_connection_delete_authority()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.preflight_run_id is not null then
    raise exception 'infrastructure connection has an active preparation or preflight lease'
      using errcode = '55006';
  end if;
  return old;
end;
$$;

drop trigger if exists infrastructure_connection_delete_authority_guard
  on public.infrastructure_connections;
create trigger infrastructure_connection_delete_authority_guard
  before delete on public.infrastructure_connections
  for each row execute function public.enforce_infrastructure_connection_delete_authority();

create or replace function public.delete_infrastructure_connection(
  p_user_id text,
  p_connection_id uuid
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
  for update;

  if not found then return 'not_found'; end if;
  if v_connection.preflight_run_id is not null then return 'blocked'; end if;

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'deleted';
end;
$$;

alter table public.hivra_agents enable row level security;
revoke all on table public.hivra_agents from public, anon, authenticated;
grant all on table public.hivra_agents to service_role;

revoke all on function public.enforce_hivra_agent_deployment_authority()
  from public, anon, authenticated;
revoke all on function public.normalize_hivra_agent_operation_compatibility()
  from public, anon, authenticated;
revoke all on function public.claim_hivra_agent_operation(text, uuid, uuid, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.request_hivra_agent_delete(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.checkpoint_hivra_agent_operation(text, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.claim_hivra_agent_operation_recovery(
  text, uuid, uuid, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.persist_hivra_agent_provision_identity(text, uuid, uuid, integer, text)
  from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_operation(text, uuid, uuid, text, text, numeric, integer)
  from public, anon, authenticated;
revoke all on function public.continue_hivra_agent_operation(text, uuid, uuid, text, text, numeric, integer)
  from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_running(text, uuid, uuid, text, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function public.release_hivra_agent_operation(text, uuid, uuid, text, boolean)
  from public, anon, authenticated;
revoke all on function public.record_hivra_agent_operation_failure(text, uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_delete(text, uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) from public, anon, authenticated;
revoke all on function public.recover_infrastructure_connection_credentials(
  text, uuid, bigint, text, smallint
) from public, anon, authenticated;
revoke all on function public.begin_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.begin_infrastructure_connection_preparation(
  text, uuid, bigint, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.enforce_infrastructure_connection_delete_authority()
  from public, anon, authenticated;
revoke all on function public.delete_infrastructure_connection(text, uuid)
  from public, anon, authenticated;
revoke all on function public.recover_expired_infrastructure_connection_run(
  text, uuid, bigint, uuid, timestamptz
) from public, anon, authenticated;

grant execute on function public.claim_hivra_agent_operation(text, uuid, uuid, text, text, jsonb)
  to service_role;
grant execute on function public.request_hivra_agent_delete(text, uuid, uuid)
  to service_role;
grant execute on function public.checkpoint_hivra_agent_operation(text, uuid, uuid, text)
  to service_role;
grant execute on function public.claim_hivra_agent_operation_recovery(
  text, uuid, uuid, timestamptz, timestamptz
) to service_role;
grant execute on function public.persist_hivra_agent_provision_identity(text, uuid, uuid, integer, text)
  to service_role;
grant execute on function public.complete_hivra_agent_operation(text, uuid, uuid, text, text, numeric, integer)
  to service_role;
grant execute on function public.continue_hivra_agent_operation(text, uuid, uuid, text, text, numeric, integer)
  to service_role;
grant execute on function public.complete_hivra_agent_running(text, uuid, uuid, text, text, text, text, timestamptz)
  to service_role;
grant execute on function public.release_hivra_agent_operation(text, uuid, uuid, text, boolean)
  to service_role;
grant execute on function public.record_hivra_agent_operation_failure(text, uuid, uuid, text)
  to service_role;
grant execute on function public.complete_hivra_agent_delete(text, uuid, uuid)
  to service_role;
grant execute on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) to service_role;
grant execute on function public.recover_infrastructure_connection_credentials(
  text, uuid, bigint, text, smallint
) to service_role;
grant execute on function public.begin_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, timestamptz
) to service_role;
grant execute on function public.begin_infrastructure_connection_preparation(
  text, uuid, bigint, uuid, timestamptz
) to service_role;
grant execute on function public.delete_infrastructure_connection(text, uuid)
  to service_role;
grant execute on function public.recover_expired_infrastructure_connection_run(
  text, uuid, bigint, uuid, timestamptz
) to service_role;

comment on column public.hivra_agents.deployment_mode is
  'Durable provider-authority discriminator. Never infer self-managed versus managed authority from nullable bindings or host labels.';
comment on column public.hivra_agents.desired_state is
  'Latest owner-requested lifecycle state. Provider operations must CAS this together with operation_id before persisting results.';
comment on column public.hivra_agents.operation_id is
  'Exclusive provider-operation lease id. Null means no provider mutation is active.';
comment on column public.hivra_agents.operation_payload is
  'Immutable parameters needed to reconcile an abandoned provider operation; resize persists requested cpu and ram before mutation.';
comment on column public.hivra_agents.allocation_operation_id is
  'Provision operation id stamped on the provider VM. New cleanup must verify the matching provider tag before destructive action.';
comment on column public.hivra_agents.infrastructure_binding_token_hash is
  'SHA-256 digest whose first 128 bits form the stable unguessable provider VM binding tag; raw token material is never persisted.';
comment on column public.hivra_agents.infrastructure_binding_token_enforced is
  'True once provider configuration carries the stable binding tag. False is reserved for guarded N-1 managed-row adoption.';
