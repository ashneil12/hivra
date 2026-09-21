-- Read-only, revision-bound host capability discovery.
--
-- Discovery evidence is deliberately separate from connection readiness and
-- launch authority. These service-role-only records do not create or mutate
-- any provider target. Preparation must consume a later, explicit contract.

create table if not exists public.infrastructure_host_discovery_runs (
  connection_id uuid primary key,
  user_id text not null,
  connection_revision bigint not null check (connection_revision > 0),
  run_id uuid not null unique,
  lease_expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint infrastructure_host_discovery_runs_owner_fk
    foreign key (connection_id, user_id)
    references public.infrastructure_connections (id, user_id)
    on delete cascade
);

create table if not exists public.infrastructure_host_discovery_snapshots (
  id uuid primary key,
  connection_id uuid not null,
  user_id text not null,
  connection_revision bigint not null check (connection_revision > 0),
  contract_version smallint not null check (contract_version = 1),
  observed_at timestamptz not null,
  expires_at timestamptz not null,
  host_identity_digest text not null
    check (host_identity_digest ~ '^[0-9a-f]{64}$'),
  snapshot jsonb not null
    check (jsonb_typeof(snapshot) = 'object')
    check (octet_length(snapshot::text) <= 65536),
  created_at timestamptz not null default now(),
  constraint infrastructure_host_discovery_snapshots_owner_fk
    foreign key (connection_id, user_id)
    references public.infrastructure_connections (id, user_id)
    on delete cascade,
  constraint infrastructure_host_discovery_snapshots_ttl_check
    check (expires_at = observed_at + interval '15 minutes'),
  constraint infrastructure_host_discovery_snapshots_payload_binding_check
    check (
      snapshot ->> 'discoveryId' is not distinct from id::text
      and snapshot ->> 'connectionId' is not distinct from connection_id::text
      and snapshot ->> 'connectionRevision' is not distinct from connection_revision::text
      and snapshot ->> 'contractVersion' is not distinct from contract_version::text
      and snapshot ->> 'hostIdentityDigest' is not distinct from host_identity_digest
      and snapshot ->> 'connectionProvider' in ('proxmox', 'host')
      and jsonb_typeof(snapshot -> 'host') is not distinct from 'object'
      and jsonb_typeof(snapshot -> 'engines') is not distinct from 'array'
      and case
        when jsonb_typeof(snapshot -> 'engines') = 'array'
          then jsonb_array_length(snapshot -> 'engines') = 9
        else false
      end
    )
);

create index if not exists infrastructure_host_discovery_snapshots_connection_observed_idx
  on public.infrastructure_host_discovery_snapshots (
    connection_id,
    connection_revision,
    observed_at desc
  );

alter table public.infrastructure_host_discovery_runs enable row level security;
alter table public.infrastructure_host_discovery_snapshots enable row level security;

revoke all on public.infrastructure_host_discovery_runs
  from public, anon, authenticated;
revoke all on public.infrastructure_host_discovery_snapshots
  from public, anon, authenticated;
grant all on public.infrastructure_host_discovery_runs to service_role;
grant all on public.infrastructure_host_discovery_snapshots to service_role;

create or replace function public.reject_infrastructure_host_discovery_snapshot_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  raise exception 'host discovery snapshots are immutable' using errcode = '55000';
end;
$$;

drop trigger if exists infrastructure_host_discovery_snapshots_immutable
  on public.infrastructure_host_discovery_snapshots;
create trigger infrastructure_host_discovery_snapshots_immutable
  before update on public.infrastructure_host_discovery_snapshots
  for each row execute function public.reject_infrastructure_host_discovery_snapshot_update();

-- Existing preparation/preflight RPCs lock the connection row before setting
-- their lease. Discovery takes the same row lock before inserting its run.
-- This trigger supplies the reverse edge, so a read cannot overlap a remote
-- host preparation and record a half-mutated capability snapshot.
create or replace function public.prevent_preflight_during_host_discovery()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.preflight_run_id is not null
    and new.preflight_run_id is distinct from old.preflight_run_id
    and exists (
      select 1
      from public.infrastructure_host_discovery_runs discovery_run
      where discovery_run.connection_id = old.id
        and discovery_run.user_id = old.user_id
        and discovery_run.connection_revision = old.revision
        and discovery_run.lease_expires_at > statement_timestamp()
    )
  then
    raise exception 'infrastructure connection has an active host discovery lease'
      using errcode = '55006';
  end if;
  return new;
end;
$$;

drop trigger if exists infrastructure_connection_host_discovery_guard
  on public.infrastructure_connections;
create trigger infrastructure_connection_host_discovery_guard
  before update of preflight_run_id on public.infrastructure_connections
  for each row execute function public.prevent_preflight_during_host_discovery();

create or replace function public.begin_infrastructure_host_discovery(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_existing public.infrastructure_host_discovery_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return false; end if;

  -- Preparation/preflight owns a stronger host mutation/readiness lease.
  if v_connection.preflight_run_id is not null then return false; end if;

  select * into v_existing
  from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
  for update;

  if found
    and v_existing.run_id = p_run_id
    and v_existing.user_id = p_user_id
    and v_existing.connection_revision = p_expected_revision
    and v_existing.lease_expires_at > v_now
  then
    return true;
  end if;

  if found
    and v_existing.connection_revision = p_expected_revision
    and v_existing.lease_expires_at > v_now
  then
    return false;
  end if;

  insert into public.infrastructure_host_discovery_runs (
    connection_id,
    user_id,
    connection_revision,
    run_id,
    lease_expires_at
  ) values (
    p_connection_id,
    p_user_id,
    p_expected_revision,
    p_run_id,
    v_now + interval '2 minutes'
  )
  on conflict (connection_id) do update
  set user_id = excluded.user_id,
      connection_revision = excluded.connection_revision,
      run_id = excluded.run_id,
      lease_expires_at = excluded.lease_expires_at,
      created_at = v_now;

  return true;
end;
$$;

create or replace function public.complete_infrastructure_host_discovery(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_host_identity_digest text,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_run public.infrastructure_host_discovery_runs%rowtype;
  v_now timestamptz := statement_timestamp();
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return false; end if;

  select * into v_run
  from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connection_revision = p_expected_revision
    and run_id = p_run_id
  for update;
  if not found or v_run.lease_expires_at <= v_now then return false; end if;

  if p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object'
    or octet_length(p_snapshot::text) > 65536
    or p_observed_at < v_now - interval '2 minutes'
    or p_observed_at > v_now + interval '1 minute'
    or p_expires_at <> p_observed_at + interval '15 minutes'
    or p_expires_at <= v_now
    or p_host_identity_digest !~ '^[0-9a-f]{64}$'
    or p_snapshot ->> 'discoveryId' is distinct from p_run_id::text
    or p_snapshot ->> 'connectionId' is distinct from p_connection_id::text
    or p_snapshot ->> 'connectionRevision' is distinct from p_expected_revision::text
    or p_snapshot ->> 'connectionProvider' is distinct from v_connection.provider
    or p_snapshot ->> 'contractVersion' is distinct from '1'
    or p_snapshot ->> 'hostIdentityDigest' is distinct from p_host_identity_digest
    or jsonb_typeof(p_snapshot -> 'host') is distinct from 'object'
    or jsonb_typeof(p_snapshot -> 'engines') is distinct from 'array'
    or (
      case
        when jsonb_typeof(p_snapshot -> 'engines') = 'array'
          then jsonb_array_length(p_snapshot -> 'engines') <> 9
        else true
      end
    )
  then
    raise exception 'host discovery snapshot is invalid' using errcode = '22023';
  end if;

  insert into public.infrastructure_host_discovery_snapshots (
    id,
    connection_id,
    user_id,
    connection_revision,
    contract_version,
    observed_at,
    expires_at,
    host_identity_digest,
    snapshot
  ) values (
    p_run_id,
    p_connection_id,
    p_user_id,
    p_expected_revision,
    1,
    p_observed_at,
    p_expires_at,
    p_host_identity_digest,
    p_snapshot
  );

  delete from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connection_revision = p_expected_revision
    and run_id = p_run_id;
  if not found then
    raise exception 'host discovery lease changed during completion' using errcode = '55000';
  end if;

  return true;
end;
$$;

create or replace function public.release_infrastructure_host_discovery(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  delete from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connection_revision = p_expected_revision
    and run_id = p_run_id;
  return found;
end;
$$;

revoke all on function public.reject_infrastructure_host_discovery_snapshot_update()
  from public, anon, authenticated;
revoke all on function public.prevent_preflight_during_host_discovery()
  from public, anon, authenticated;
revoke all on function public.begin_infrastructure_host_discovery(text, uuid, bigint, uuid)
  from public, anon, authenticated;
revoke all on function public.complete_infrastructure_host_discovery(
  text, uuid, bigint, uuid, timestamptz, timestamptz, text, jsonb
) from public, anon, authenticated;
revoke all on function public.release_infrastructure_host_discovery(text, uuid, bigint, uuid)
  from public, anon, authenticated;

grant execute on function public.begin_infrastructure_host_discovery(text, uuid, bigint, uuid)
  to service_role;
grant execute on function public.complete_infrastructure_host_discovery(
  text, uuid, bigint, uuid, timestamptz, timestamptz, text, jsonb
) to service_role;
grant execute on function public.release_infrastructure_host_discovery(text, uuid, bigint, uuid)
  to service_role;

comment on table public.infrastructure_host_discovery_runs is
  'Service-role-only bounded leases for read-only host discovery. They convey no preparation or launch authority.';
comment on table public.infrastructure_host_discovery_snapshots is
  'Immutable, sanitized, revision-bound host capability evidence. A snapshot is informational and conveys no preparation or launch authority.';
