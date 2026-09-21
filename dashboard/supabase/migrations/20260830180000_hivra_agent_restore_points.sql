-- Durable, owner-scoped Proxmox restore points for Hivra agent computers.
--
-- These are same-host Proxmox snapshots, deliberately not described as
-- off-host backups. Their provider identity is bound to the exact agent,
-- VMID, infrastructure revision and Hivra binding receipt that created them.
-- The lifecycle operation lease serializes snapshot/restore with power,
-- resize and deletion. Restore is intentionally synchronous and leaves the
-- VM stopped so a user can inspect the result before explicitly starting it.

create table if not exists public.hivra_agent_snapshots (
  id uuid primary key,
  user_id text not null,
  agent_id uuid not null references public.hivra_agents(id) on delete cascade,
  provider_snapshot_id text not null,
  status text not null default 'creating',
  retention_policy text not null default 'until_agent_delete',
  source_deployment_mode text not null,
  source_proxmox_host text not null,
  source_connection_id uuid null,
  source_target_id uuid null,
  source_connection_revision bigint null,
  source_binding_token_hash text not null,
  source_vmid integer not null,
  source_cpu numeric not null,
  source_ram integer not null,
  create_operation_id uuid not null,
  restore_operation_id uuid null,
  snapshot_config_sha256 text null,
  created_at timestamptz not null default now(),
  ready_at timestamptz null,
  last_restored_at timestamptz null,
  restore_count integer not null default 0,
  last_error text null,
  deleted_at timestamptz null,
  constraint hivra_agent_snapshots_provider_id_check
    check (provider_snapshot_id ~ '^hivra_[0-9a-f]{32}$'),
  constraint hivra_agent_snapshots_status_check
    check (status in ('creating', 'ready', 'restoring', 'failed', 'deleted')),
  constraint hivra_agent_snapshots_retention_check
    check (retention_policy = 'until_agent_delete'),
  constraint hivra_agent_snapshots_source_mode_check
    check (source_deployment_mode in ('hivra-managed', 'self-managed')),
  constraint hivra_agent_snapshots_binding_hash_check
    check (source_binding_token_hash ~ '^[0-9a-f]{64}$'),
  constraint hivra_agent_snapshots_config_hash_check
    check (snapshot_config_sha256 is null or snapshot_config_sha256 ~ '^[0-9a-f]{64}$'),
  constraint hivra_agent_snapshots_restore_count_check
    check (restore_count >= 0),
  constraint hivra_agent_snapshots_source_resources_check
    check (source_cpu > 0 and source_ram > 0),
  constraint hivra_agent_snapshots_source_authority_check
    check (
      (
        source_deployment_mode = 'hivra-managed'
        and source_connection_id is null
        and source_target_id is null
        and source_connection_revision is null
        and source_proxmox_host <> '__hivra_self_managed_no_ambient_authority__'
      )
      or
      (
        source_deployment_mode = 'self-managed'
        and source_connection_id is not null
        and source_target_id is not null
        and source_connection_revision is not null
        and source_connection_revision > 0
        and source_proxmox_host = '__hivra_self_managed_no_ambient_authority__'
      )
    ),
  unique (agent_id, provider_snapshot_id)
);

create index if not exists hivra_agent_snapshots_owner_agent_created_idx
  on public.hivra_agent_snapshots(user_id, agent_id, created_at desc);

alter table public.hivra_agent_snapshots enable row level security;

drop policy if exists hivra_agent_snapshots_owner_select
  on public.hivra_agent_snapshots;
create policy hivra_agent_snapshots_owner_select
  on public.hivra_agent_snapshots
  for select
  to authenticated
  using (user_id = current_setting('request.jwt.claims', true)::json ->> 'sub');

revoke all on table public.hivra_agent_snapshots from anon, authenticated;
grant select on table public.hivra_agent_snapshots to authenticated;
grant all on table public.hivra_agent_snapshots to service_role;

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
        and operation_kind in (
          'provision', 'start', 'stop', 'restart', 'resize', 'snapshot',
          'restore', 'delete'
        )
        and operation_started_at is not null
        and (operation_payload is null or jsonb_typeof(operation_payload) = 'object')
      )
    ) not valid;
alter table public.hivra_agents
  validate constraint hivra_agents_operation_shape_check;

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
    or p_operation_kind not in ('start', 'stop', 'restart', 'resize', 'snapshot', 'restore')
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
    p_operation_kind in ('snapshot', 'restore')
    and (
      p_operation_payload is null
      or jsonb_typeof(p_operation_payload) <> 'object'
      or coalesce(p_operation_payload ->> 'snapshotId', '')
        !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or coalesce(p_operation_payload ->> 'providerSnapshotId', '')
        !~ '^hivra_[0-9a-f]{32}$'
    )
  ) or (
    p_operation_kind not in ('resize', 'snapshot', 'restore')
    and p_operation_payload is not null
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

  if p_operation_kind = 'snapshot' and (
    v_agent.status not in ('running', 'stopped')
    or p_desired_state <> v_agent.desired_state
  ) then
    return false;
  end if;
  if p_operation_kind = 'restore' and (
    v_agent.status not in ('running', 'stopped')
    or p_desired_state <> 'stopped'
  ) then
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

create or replace function public.begin_hivra_agent_snapshot(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_provider_snapshot_id text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_claimed boolean;
begin
  select * into v_agent
  from public.hivra_agents
  where id = p_agent_id and user_id = p_user_id
  for update;

  if not found
    or v_agent.computer_substrate is distinct from 'proxmox-kvm'
    or not v_agent.infrastructure_binding_token_enforced
    or v_agent.vmid is null
    or v_agent.status not in ('running', 'stopped')
    or v_agent.desired_state <> v_agent.status
    or p_provider_snapshot_id <> ('hivra_' || replace(p_snapshot_id::text, '-', ''))
    or (
      select count(*)
      from public.hivra_agent_snapshots
      where agent_id = p_agent_id
        and user_id = p_user_id
        and status <> 'deleted'
    ) >= 5
  then
    return false;
  end if;

  v_claimed := public.claim_hivra_agent_operation(
    p_user_id,
    p_agent_id,
    p_operation_id,
    'snapshot',
    v_agent.desired_state,
    jsonb_build_object(
      'snapshotId', p_snapshot_id::text,
      'providerSnapshotId', p_provider_snapshot_id
    )
  );
  if not v_claimed then return false; end if;

  insert into public.hivra_agent_snapshots (
    id, user_id, agent_id, provider_snapshot_id, source_deployment_mode,
    source_proxmox_host, source_connection_id, source_target_id,
    source_connection_revision, source_binding_token_hash, source_vmid,
    source_cpu, source_ram, create_operation_id
  ) values (
    p_snapshot_id, p_user_id, p_agent_id, p_provider_snapshot_id,
    v_agent.deployment_mode, v_agent.proxmox_host,
    v_agent.infrastructure_connection_id, v_agent.deployment_target_id,
    v_agent.infrastructure_connection_revision,
    v_agent.infrastructure_binding_token_hash, v_agent.vmid,
    v_agent.cpu, v_agent.ram, p_operation_id
  );
  return true;
end;
$$;

create or replace function public.complete_hivra_agent_snapshot(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_provider_status text,
  p_snapshot_config_sha256 text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_completed boolean;
begin
  if p_provider_status not in ('running', 'stopped')
    or p_snapshot_config_sha256 !~ '^[0-9a-f]{64}$'
  then
    raise exception 'invalid Hivra snapshot completion evidence' using errcode = '22023';
  end if;

  v_completed := public.complete_hivra_agent_operation(
    p_user_id, p_agent_id, p_operation_id, p_provider_status,
    p_provider_status, null, null
  );
  if not v_completed then return false; end if;

  update public.hivra_agent_snapshots
  set status = 'ready',
      snapshot_config_sha256 = p_snapshot_config_sha256,
      ready_at = now(),
      last_error = null
  where id = p_snapshot_id
    and user_id = p_user_id
    and agent_id = p_agent_id
    and create_operation_id = p_operation_id
    and status = 'creating';
  if not found then
    raise exception 'snapshot completion lost its durable identity' using errcode = '55000';
  end if;
  return true;
end;
$$;

create or replace function public.fail_hivra_agent_snapshot(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_provider_status text,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_completed boolean;
begin
  if p_provider_status not in ('running', 'stopped') then
    raise exception 'invalid Hivra snapshot provider status' using errcode = '22023';
  end if;
  select * into v_agent from public.hivra_agents
  where id = p_agent_id and user_id = p_user_id
    and operation_id = p_operation_id and operation_kind = 'snapshot'
  for update;
  if not found then return false; end if;

  v_completed := public.complete_hivra_agent_operation(
    p_user_id, p_agent_id, p_operation_id, v_agent.desired_state,
    p_provider_status, null, null
  );
  if not v_completed then return false; end if;
  update public.hivra_agent_snapshots
  set status = 'failed', last_error = left(coalesce(p_error, 'snapshot failed'), 300)
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
    and create_operation_id = p_operation_id and status = 'creating';
  if not found then
    raise exception 'snapshot failure lost its durable identity' using errcode = '55000';
  end if;
  return true;
end;
$$;

create or replace function public.begin_hivra_agent_snapshot_restore(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_agent public.hivra_agents%rowtype;
  v_snapshot public.hivra_agent_snapshots%rowtype;
  v_claimed boolean;
begin
  select * into v_agent from public.hivra_agents
  where id = p_agent_id and user_id = p_user_id
  for update;
  if not found or v_agent.status not in ('running', 'stopped') then return false; end if;

  select * into v_snapshot from public.hivra_agent_snapshots
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
  for update;
  if not found
    or v_snapshot.status <> 'ready'
    or v_snapshot.snapshot_config_sha256 is null
    or v_snapshot.source_deployment_mode <> v_agent.deployment_mode
    or v_snapshot.source_proxmox_host <> v_agent.proxmox_host
    or v_snapshot.source_connection_id is distinct from v_agent.infrastructure_connection_id
    or v_snapshot.source_target_id is distinct from v_agent.deployment_target_id
    or v_snapshot.source_connection_revision is distinct from v_agent.infrastructure_connection_revision
    or v_snapshot.source_binding_token_hash <> v_agent.infrastructure_binding_token_hash
    or v_snapshot.source_vmid <> v_agent.vmid
  then
    return false;
  end if;

  v_claimed := public.claim_hivra_agent_operation(
    p_user_id,
    p_agent_id,
    p_operation_id,
    'restore',
    'stopped',
    jsonb_build_object(
      'snapshotId', p_snapshot_id::text,
      'providerSnapshotId', v_snapshot.provider_snapshot_id
    )
  );
  if not v_claimed then return false; end if;

  update public.hivra_agent_snapshots
  set status = 'restoring', restore_operation_id = p_operation_id, last_error = null
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id;
  return true;
end;
$$;

create or replace function public.complete_hivra_agent_snapshot_restore(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_snapshot_config_sha256 text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_snapshot public.hivra_agent_snapshots%rowtype;
  v_completed boolean;
begin
  if p_snapshot_config_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid Hivra restore completion evidence' using errcode = '22023';
  end if;
  select * into v_snapshot
    from public.hivra_agent_snapshots
    where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
      and status = 'restoring' and restore_operation_id = p_operation_id
      and snapshot_config_sha256 = p_snapshot_config_sha256
    for update;
  if not found then
    return false;
  end if;

  v_completed := public.complete_hivra_agent_operation(
    p_user_id, p_agent_id, p_operation_id, 'stopped', 'stopped',
    v_snapshot.source_cpu, v_snapshot.source_ram
  );
  if not v_completed then return false; end if;

  update public.hivra_agent_snapshots
  set status = 'ready',
      restore_operation_id = null,
      last_restored_at = now(),
      restore_count = restore_count + 1,
      last_error = null
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
    and status = 'restoring' and restore_operation_id = p_operation_id;
  if not found then
    raise exception 'restore completion lost its durable identity' using errcode = '55000';
  end if;
  return true;
end;
$$;

create or replace function public.fail_hivra_agent_snapshot_restore(
  p_user_id text,
  p_agent_id uuid,
  p_operation_id uuid,
  p_snapshot_id uuid,
  p_provider_status text,
  p_error text
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_completed boolean;
begin
  if p_provider_status not in ('running', 'stopped') then
    raise exception 'invalid Hivra restore provider status' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.hivra_agent_snapshots
    where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
      and status = 'restoring' and restore_operation_id = p_operation_id
  ) then
    return false;
  end if;
  v_completed := public.complete_hivra_agent_operation(
    p_user_id, p_agent_id, p_operation_id, 'stopped', p_provider_status, null, null
  );
  if not v_completed then return false; end if;
  update public.hivra_agent_snapshots
  set status = 'ready', restore_operation_id = null,
      last_error = left(coalesce(p_error, 'restore failed'), 300)
  where id = p_snapshot_id and user_id = p_user_id and agent_id = p_agent_id
    and status = 'restoring' and restore_operation_id = p_operation_id;
  if not found then
    raise exception 'restore failure lost its durable identity' using errcode = '55000';
  end if;
  return true;
end;
$$;

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
  if v_updated then
    update public.hivra_agent_snapshots
    set status = 'deleted', deleted_at = now(), restore_operation_id = null,
        last_error = null
    where agent_id = p_agent_id and user_id = p_user_id and status <> 'deleted';
  end if;
  return v_updated;
end;
$$;

revoke all on function public.begin_hivra_agent_snapshot(text, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_snapshot(text, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.fail_hivra_agent_snapshot(text, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.begin_hivra_agent_snapshot_restore(text, uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.complete_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.begin_hivra_agent_snapshot(text, uuid, uuid, uuid, text) to service_role;
grant execute on function public.complete_hivra_agent_snapshot(text, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.fail_hivra_agent_snapshot(text, uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.begin_hivra_agent_snapshot_restore(text, uuid, uuid, uuid) to service_role;
grant execute on function public.complete_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text) to service_role;
grant execute on function public.fail_hivra_agent_snapshot_restore(text, uuid, uuid, uuid, text, text) to service_role;
