-- Preserve portable deployment-target identity and bind Hivra agents to one
-- exact owner-scoped target. Legacy managed-fleet rows remain unbound.
--
-- This migration is intentionally additive. It replaces the preflight RPC
-- bodies from 20260825170000 so refreshing evidence never deletes a target row
-- that a lifecycle record may reference.

alter table public.deployment_targets
  add column if not exists evidence_connection_revision bigint;

-- Existing target evidence was produced from the connection revision current
-- when the original migration completed its preflight.
update public.deployment_targets as target
set evidence_connection_revision = connection.revision
from public.infrastructure_connections as connection
where connection.id = target.connection_id
  and connection.user_id = target.user_id
  and target.evidence_connection_revision is null;

alter table public.deployment_targets
  alter column evidence_connection_revision set not null;

-- Target rows written before runtime-compatibility evidence existed must not
-- remain launch authority. Preserve their identity for bound lifecycle rows,
-- but require a fresh preflight to repopulate a versioned compatibility record.
update public.deployment_targets
set status = 'unavailable',
    capabilities = jsonb_set(
      jsonb_set(
        coalesce(capabilities, '{}'::jsonb),
        '{launchReady}',
        'false'::jsonb,
        true
      ),
      '{runtimeCompatibility}',
      'null'::jsonb,
      true
    ),
    supported_isolation_drivers = '{}'::text[],
    isolation_class = null,
    last_error_code = 'PREFLIGHT_SUPERSEDED'
where not (coalesce(capabilities, '{}'::jsonb) ? 'runtimeCompatibility')
   or coalesce(capabilities #>> '{runtimeCompatibility,provisionerVersion}', '') <> '2026.08.26.5'
   or coalesce(capabilities #>> '{provisioner,version}', '') <> '2026.08.26.5';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deployment_targets_evidence_revision_check'
      and conrelid = 'public.deployment_targets'::regclass
  ) then
    alter table public.deployment_targets
      add constraint deployment_targets_evidence_revision_check
      check (evidence_connection_revision > 0);
  end if;
end
$$;

-- Required by the Hivra composite foreign key below. Including connection_id
-- and user_id makes a target id insufficient on its own: the bound target must
-- belong to the same connection and owner as the agent row.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deployment_targets_id_connection_user_key'
      and conrelid = 'public.deployment_targets'::regclass
  ) then
    alter table public.deployment_targets
      add constraint deployment_targets_id_connection_user_key
      unique (id, connection_id, user_id);
  end if;
end
$$;

alter table public.hivra_agents
  add column if not exists infrastructure_connection_id uuid,
  add column if not exists deployment_target_id uuid,
  add column if not exists infrastructure_connection_revision bigint;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hivra_agents_self_managed_binding_complete_check'
      and conrelid = 'public.hivra_agents'::regclass
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_self_managed_binding_complete_check
      check (
        (
          infrastructure_connection_id is null
          and deployment_target_id is null
          and infrastructure_connection_revision is null
        )
        or
        (
          infrastructure_connection_id is not null
          and deployment_target_id is not null
          and infrastructure_connection_revision is not null
          and infrastructure_connection_revision > 0
        )
      );
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'hivra_agents_self_managed_target_fk'
      and conrelid = 'public.hivra_agents'::regclass
  ) then
    alter table public.hivra_agents
      add constraint hivra_agents_self_managed_target_fk
      foreign key (
        deployment_target_id,
        infrastructure_connection_id,
        user_id
      )
      references public.deployment_targets (id, connection_id, user_id)
      on update restrict
      on delete restrict;
  end if;
end
$$;

create index if not exists hivra_agents_infrastructure_connection_idx
  on public.hivra_agents (infrastructure_connection_id)
  where infrastructure_connection_id is not null;

create index if not exists hivra_agents_deployment_target_idx
  on public.hivra_agents (deployment_target_id)
  where deployment_target_id is not null;

-- Managed-fleet VMIDs are host-local. Restrict the legacy index to unbound rows
-- so a self-managed node with the same display name and VMID cannot collide.
drop index if exists public.hivra_agents_active_proxmox_host_vmid_idx;
create unique index hivra_agents_active_proxmox_host_vmid_idx
  on public.hivra_agents (
    (coalesce(nullif(proxmox_host, ''), '__legacy__')),
    vmid
  )
  where vmid is not null
    and deployment_target_id is null
    and status <> 'deleted';

-- Self-managed VMIDs are unique only inside the immutable target identity.
create unique index if not exists hivra_agents_active_self_managed_target_vmid_idx
  on public.hivra_agents (deployment_target_id, vmid)
  where deployment_target_id is not null
    and vmid is not null
    and status <> 'deleted';

comment on column public.deployment_targets.evidence_connection_revision is
  'Connection revision whose preflight produced this target evidence. Lifecycle resolution must fail closed when it differs from the current connection revision.';

comment on column public.hivra_agents.infrastructure_connection_id is
  'Nullable only for legacy managed-fleet rows. Self-managed agents bind to one owner-scoped infrastructure connection.';

comment on column public.hivra_agents.deployment_target_id is
  'Nullable only for legacy managed-fleet rows. Self-managed lifecycle operations must use this exact deployment target and never infer authority from proxmox_host.';

comment on column public.hivra_agents.infrastructure_connection_revision is
  'Connection revision accepted when the self-managed agent was bound. Lifecycle resolution must fail closed on revision mismatch.';

-- Connection edits preserve target ids but make all prior evidence unusable.
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

  if not found then
    return;
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

-- A preflight lease invalidates readiness without deleting target identity.
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
  v_updated boolean := false;
begin
  update public.infrastructure_connections
  set status = 'checking',
      preflight_run_id = p_run_id,
      last_checked_at = p_started_at,
      last_error_code = null
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision;
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

-- Replace evidence in place. The unique conflict target deliberately excludes
-- deployment_targets.id so an existing target keeps the same immutable id.
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
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
    and preflight_run_id = p_run_id
  for update;

  if not found then
    return false;
  end if;

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
      user_id,
      connection_id,
      external_id,
      display_name,
      status,
      capacity,
      capabilities,
      supported_isolation_drivers,
      isolation_class,
      last_preflight_at,
      last_error_code,
      evidence_connection_revision
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

  update public.infrastructure_connections
  set status = p_connection_status,
      preflight_run_id = null,
      last_checked_at = p_checked_at,
      last_error_code = p_last_error_code
  where id = p_connection_id
    and user_id = p_user_id;

  return true;
end;
$$;

-- Credential/decryption failure also revokes readiness without deleting the
-- identity a bound Hivra agent may need for a later verified teardown.
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
begin
  update public.infrastructure_connections
  set status = 'error',
      preflight_run_id = null,
      last_checked_at = p_checked_at,
      last_error_code = p_last_error_code
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision;
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

revoke all on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) from public, anon, authenticated;
revoke all on function public.begin_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.complete_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, text, timestamptz, text, jsonb
) from public, anon, authenticated;
revoke all on function public.invalidate_infrastructure_connection_preflight(
  text, uuid, bigint, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) to service_role;
grant execute on function public.begin_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, timestamptz
) to service_role;
grant execute on function public.complete_infrastructure_connection_preflight(
  text, uuid, bigint, uuid, text, timestamptz, text, jsonb
) to service_role;
grant execute on function public.invalidate_infrastructure_connection_preflight(
  text, uuid, bigint, timestamptz, text
) to service_role;

comment on table public.deployment_targets is
  'Stable owner-scoped deployment-target identities with sanitized, revision-bound preflight evidence. Target rows are preserved across preflight refreshes and connection edits.';
