-- Owner-scoped, user-provided infrastructure for portable Hivra deployments.
--
-- This first milestone records a prepared Proxmox connection and the targets
-- discovered by its read-only preflight. It intentionally does not bind an
-- agent or lifecycle operation to a target yet. Connection credentials live in
-- a separate service-role-only table; browser-readable rows contain metadata
-- only.

create table if not exists public.infrastructure_connections (
  id                              uuid        primary key default gen_random_uuid(),
  user_id                         text        not null check (btrim(user_id) <> ''),
  name                            text        not null check (btrim(name) <> ''),
  provider                        text        not null default 'proxmox'
                                              check (provider in ('proxmox')),
  operating_mode                  text        not null default 'self-managed'
                                              check (operating_mode in ('self-managed')),
  setup_mode                      text        not null default 'simple'
                                              check (setup_mode in ('simple', 'advanced')),
  status                          text        not null default 'pending'
                                              check (status in ('pending', 'checking', 'ready', 'error', 'disabled')),
  ssh_host                        text        not null check (btrim(ssh_host) <> ''),
  ssh_port                        integer     not null default 22
                                              check (ssh_port between 1 and 65535),
  ssh_user                        text        not null default 'root'
                                              check (btrim(ssh_user) <> ''),
  -- The API normalizes SHA256:BASE64 and colon-delimited input to lowercase
  -- SHA-256 hex before persistence. A user-owned SSH connection is never
  -- allowed to fall back to trust-on-first-use.
  ssh_host_fingerprint_sha256     text        not null
                                              check (
                                                char_length(ssh_host_fingerprint_sha256) = 64
                                                and ssh_host_fingerprint_sha256 ~ '^[0-9a-f]{64}$'
                                              ),
  config                          jsonb       not null default '{}'::jsonb
                                              check (jsonb_typeof(config) = 'object'),
  -- Monotonic configuration revision. Status-only preflight writes do not
  -- change it; connection edits and credential rotation do. Long-running
  -- preflights use this with preflight_run_id to reject stale completion.
  revision                        bigint      not null default 1 check (revision > 0),
  preflight_run_id                uuid,
  last_checked_at                 timestamptz,
  last_error_code                 text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint infrastructure_connections_id_user_key unique (id, user_id)
);

create unique index if not exists infrastructure_connections_user_name_key
  on public.infrastructure_connections (user_id, lower(name));

create index if not exists infrastructure_connections_user_status_idx
  on public.infrastructure_connections (user_id, status, created_at desc);

drop trigger if exists infrastructure_connections_updated_at
  on public.infrastructure_connections;
create trigger infrastructure_connections_updated_at
  before update on public.infrastructure_connections
  for each row execute function public.update_updated_at();

-- One encrypted, versioned credential envelope per connection. This table has
-- RLS enabled with no browser policy and no browser grant. Server routes use
-- the service-role client after independently enforcing connection ownership.
create table if not exists public.infrastructure_connection_secrets (
  connection_id                   uuid        primary key,
  user_id                         text        not null check (btrim(user_id) <> ''),
  encrypted_bundle                text        not null check (btrim(encrypted_bundle) <> ''),
  key_version                     smallint    not null default 1 check (key_version > 0),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint infrastructure_connection_secrets_owner_fk
    foreign key (connection_id, user_id)
    references public.infrastructure_connections (id, user_id)
    on delete cascade
);

drop trigger if exists infrastructure_connection_secrets_updated_at
  on public.infrastructure_connection_secrets;
create trigger infrastructure_connection_secrets_updated_at
  before update on public.infrastructure_connection_secrets
  for each row execute function public.update_updated_at();

-- A target is a Proxmox node discovered and capacity-checked by preflight.
-- Capacity and capability documents must be sanitized before persistence; no
-- raw command output or credential material belongs in either JSON document.
create table if not exists public.deployment_targets (
  id                              uuid        primary key default gen_random_uuid(),
  user_id                         text        not null check (btrim(user_id) <> ''),
  connection_id                   uuid        not null,
  external_id                     text        not null check (btrim(external_id) <> ''),
  display_name                    text        not null check (btrim(display_name) <> ''),
  status                          text        not null default 'pending'
                                              check (status in ('pending', 'ready', 'unavailable', 'error', 'disabled')),
  capacity                        jsonb       not null default '{}'::jsonb
                                              check (jsonb_typeof(capacity) = 'object'),
  capabilities                    jsonb       not null default '{}'::jsonb
                                              check (jsonb_typeof(capabilities) = 'object'),
  supported_isolation_drivers     text[]      not null default '{}'::text[]
                                              check (
                                                supported_isolation_drivers <@ array['proxmox-kvm']::text[]
                                              ),
  -- Null means hardware-backed isolation was not proven. Never infer a
  -- security boundary from provider type alone.
  isolation_class                 text
                                              check (isolation_class is null or isolation_class in ('hardware-vm')),
  last_preflight_at               timestamptz,
  last_error_code                 text,
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now(),
  constraint deployment_targets_id_user_key unique (id, user_id),
  constraint deployment_targets_connection_external_key unique (connection_id, external_id),
  constraint deployment_targets_owner_connection_fk
    foreign key (connection_id, user_id)
    references public.infrastructure_connections (id, user_id)
    on delete cascade
);

create index if not exists deployment_targets_user_status_idx
  on public.deployment_targets (user_id, status, created_at desc);

drop trigger if exists deployment_targets_updated_at
  on public.deployment_targets;
create trigger deployment_targets_updated_at
  before update on public.deployment_targets
  for each row execute function public.update_updated_at();

-- Create metadata and its encrypted credential envelope in one transaction.
-- All RPCs in this migration are service-role only; ownership is still passed
-- explicitly and checked in every statement.
create or replace function public.create_infrastructure_connection(
  p_user_id text,
  p_name text,
  p_setup_mode text,
  p_ssh_host text,
  p_ssh_port integer,
  p_ssh_user text,
  p_ssh_host_fingerprint_sha256 text,
  p_config jsonb,
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
  insert into public.infrastructure_connections (
    user_id,
    name,
    provider,
    operating_mode,
    setup_mode,
    status,
    ssh_host,
    ssh_port,
    ssh_user,
    ssh_host_fingerprint_sha256,
    config
  ) values (
    p_user_id,
    p_name,
    'proxmox',
    'self-managed',
    p_setup_mode,
    'pending',
    p_ssh_host,
    p_ssh_port,
    p_ssh_user,
    p_ssh_host_fingerprint_sha256,
    coalesce(p_config, '{}'::jsonb)
  )
  returning * into v_connection;

  insert into public.infrastructure_connection_secrets (
    connection_id,
    user_id,
    encrypted_bundle,
    key_version
  ) values (
    v_connection.id,
    p_user_id,
    p_encrypted_bundle,
    p_key_version
  );

  return next v_connection;
end;
$$;

-- Apply connection metadata and credential changes atomically. The expected
-- revision is an optimistic concurrency guard. Operational changes revoke any
-- in-flight preflight lease and delete now-stale derived target evidence.
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
    delete from public.deployment_targets
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

-- Claim the current connection revision for one preflight run and remove any
-- older evidence before network I/O begins. A newer run may supersede this one
-- by replacing preflight_run_id without changing the configuration revision.
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
    delete from public.deployment_targets
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return v_updated;
end;
$$;

-- Persist the final connection state and its single sanitized target evidence
-- document atomically, but only while the same revision and run lease remain
-- current. This prevents PATCH and overlapping preflight races from reviving
-- stale readiness.
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

  delete from public.deployment_targets
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
      last_error_code
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
      p_target ->> 'lastErrorCode'
    );
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

-- Credential decryption can fail before a run lease is claimed. Invalidate
-- prior evidence only if the connection revision that failed is still current.
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
    delete from public.deployment_targets
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return v_updated;
end;
$$;

-- Key rotation must compare the ciphertext it read without placing that
-- secret in a PostgREST query string. RPC arguments travel in the POST body;
-- the compare-and-swap happens inside PostgreSQL.
create or replace function public.rotate_infrastructure_connection_secret(
  p_connection_id uuid,
  p_expected_encrypted_bundle text,
  p_encrypted_bundle text,
  p_key_version smallint
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.infrastructure_connection_secrets
  set encrypted_bundle = p_encrypted_bundle,
      key_version = p_key_version
  where connection_id = p_connection_id
    and encrypted_bundle = p_expected_encrypted_bundle;
  v_updated := found;
  return v_updated;
end;
$$;

alter table public.infrastructure_connections enable row level security;
alter table public.infrastructure_connection_secrets enable row level security;
alter table public.deployment_targets enable row level security;

-- Browser clients may inspect their own non-secret metadata. Mutations go
-- through authenticated server routes so target status/capability evidence
-- cannot be forged directly through the data API.
drop policy if exists "users can view own infrastructure connections"
  on public.infrastructure_connections;
create policy "users can view own infrastructure connections"
  on public.infrastructure_connections
  for select
  to authenticated
  using ((select public.requesting_user_id()) = user_id);

drop policy if exists "users can view own deployment targets"
  on public.deployment_targets;
create policy "users can view own deployment targets"
  on public.deployment_targets
  for select
  to authenticated
  using ((select public.requesting_user_id()) = user_id);

revoke all on public.infrastructure_connections from anon, authenticated;
revoke all on public.infrastructure_connection_secrets from anon, authenticated;
revoke all on public.deployment_targets from anon, authenticated;

grant select on public.infrastructure_connections to authenticated;
grant select on public.deployment_targets to authenticated;

grant all on public.infrastructure_connections to service_role;
grant all on public.infrastructure_connection_secrets to service_role;
grant all on public.deployment_targets to service_role;

revoke all on function public.create_infrastructure_connection(
  text, text, text, text, integer, text, text, jsonb, text, smallint
) from public, anon, authenticated;
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
revoke all on function public.rotate_infrastructure_connection_secret(
  uuid, text, text, smallint
) from public, anon, authenticated;

grant execute on function public.create_infrastructure_connection(
  text, text, text, text, integer, text, text, jsonb, text, smallint
) to service_role;
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
grant execute on function public.rotate_infrastructure_connection_secret(
  uuid, text, text, smallint
) to service_role;

comment on table public.infrastructure_connections is
  'Owner-scoped non-secret metadata for user-provided deployment infrastructure. First supported provider: prepared Proxmox over pinned SSH.';

comment on table public.infrastructure_connection_secrets is
  'Service-role-only encrypted credential envelopes for infrastructure connections. No anon or authenticated policies or grants.';

comment on table public.deployment_targets is
  'Sanitized Proxmox nodes and capacity/capability evidence discovered by portable read-only preflight. Not yet bound to agent lifecycle operations.';
