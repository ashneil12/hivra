-- Owner-scoped Hetzner Cloud project connections and sanitized capacity
-- inventory. This migration intentionally does not create provider resources
-- or publish deployment targets: a discovered cloud server is not agent-launch
-- authority until the provider-VM bootstrap contract is implemented.

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_provider_check;

alter table public.infrastructure_connections
  alter column ssh_host drop not null,
  alter column ssh_port drop not null,
  alter column ssh_user drop not null,
  alter column ssh_host_fingerprint_sha256 drop not null;

alter table public.infrastructure_connections
  add constraint infrastructure_connections_provider_check
  check (provider in ('proxmox', 'host', 'hetzner-cloud')) not valid;

alter table public.infrastructure_connections
  validate constraint infrastructure_connections_provider_check;

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_provider_endpoint_check;

alter table public.infrastructure_connections
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
      provider = 'hetzner-cloud'
      and setup_mode = 'simple'
      and ssh_host is null
      and ssh_port is null
      and ssh_user is null
      and ssh_host_fingerprint_sha256 is null
    )
  ) not valid;

alter table public.infrastructure_connections
  validate constraint infrastructure_connections_provider_endpoint_check;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'infrastructure_connections_id_user_provider_key'
      and conrelid = 'public.infrastructure_connections'::regclass
  ) then
    alter table public.infrastructure_connections
      add constraint infrastructure_connections_id_user_provider_key
      unique (id, user_id, provider);
  end if;
end
$$;

create table if not exists public.infrastructure_capacity_inventory (
  id                    uuid        primary key default gen_random_uuid(),
  user_id               text        not null check (btrim(user_id) <> ''),
  connection_id         uuid        not null,
  provider              text        not null default 'hetzner-cloud'
                                    check (provider = 'hetzner-cloud'),
  provider_resource_id  text        not null
                                    check (provider_resource_id ~ '^[1-9][0-9]*$'),
  name                  text        not null
                                    check (btrim(name) <> '' and char_length(name) <= 128),
  provider_status       text        not null
                                    check (
                                      provider_status in (
                                        'running', 'off', 'initializing', 'starting',
                                        'stopping', 'deleting', 'rebuilding', 'migrating',
                                        'unknown'
                                      )
                                    ),
  server_type           jsonb       not null check (jsonb_typeof(server_type) = 'object'),
  location              jsonb       not null check (jsonb_typeof(location) = 'object'),
  public_network        jsonb       not null check (jsonb_typeof(public_network) = 'object'),
  provider_created_at   timestamptz not null,
  discovered_at         timestamptz not null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint infrastructure_capacity_inventory_owner_connection_fk
    foreign key (connection_id, user_id, provider)
    references public.infrastructure_connections (id, user_id, provider)
    on delete cascade,
  constraint infrastructure_capacity_inventory_connection_resource_key
    unique (connection_id, provider_resource_id)
);

create index if not exists infrastructure_capacity_inventory_user_connection_idx
  on public.infrastructure_capacity_inventory (user_id, connection_id, created_at desc);

drop trigger if exists infrastructure_capacity_inventory_updated_at
  on public.infrastructure_capacity_inventory;
create trigger infrastructure_capacity_inventory_updated_at
  before update on public.infrastructure_capacity_inventory
  for each row execute function public.update_updated_at();

alter table public.infrastructure_capacity_inventory enable row level security;

drop policy if exists "users can view own infrastructure capacity inventory"
  on public.infrastructure_capacity_inventory;
create policy "users can view own infrastructure capacity inventory"
  on public.infrastructure_capacity_inventory
  for select
  using ((select public.requesting_user_id()) = user_id);

revoke all on public.infrastructure_capacity_inventory from public, anon, authenticated;
grant select on public.infrastructure_capacity_inventory to authenticated;
grant all on public.infrastructure_capacity_inventory to service_role;

create or replace function public.create_hetzner_cloud_infrastructure_connection(
  p_user_id text,
  p_name text,
  p_encrypted_bundle text,
  p_key_version smallint,
  p_discovered_at timestamptz,
  p_inventory jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_inventory jsonb;
begin
  if jsonb_typeof(coalesce(p_inventory, '[]'::jsonb)) <> 'array' then
    raise exception 'Hetzner inventory must be an array' using errcode = '22023';
  end if;

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
    config,
    last_checked_at,
    last_error_code
  ) values (
    p_user_id,
    p_name,
    'hetzner-cloud',
    'self-managed',
    'simple',
    'ready',
    null,
    null,
    null,
    null,
    '{}'::jsonb,
    p_discovered_at,
    null
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

  insert into public.infrastructure_capacity_inventory (
    user_id,
    connection_id,
    provider,
    provider_resource_id,
    name,
    provider_status,
    server_type,
    location,
    public_network,
    provider_created_at,
    discovered_at
  )
  select
    p_user_id,
    v_connection.id,
    'hetzner-cloud',
    item.provider_resource_id,
    item.name,
    item.provider_status,
    item.server_type,
    item.location,
    item.public_network,
    item.provider_created_at,
    item.discovered_at
  from jsonb_to_recordset(coalesce(p_inventory, '[]'::jsonb)) as item(
    provider_resource_id text,
    name text,
    provider_status text,
    server_type jsonb,
    location jsonb,
    public_network jsonb,
    provider_created_at timestamptz,
    discovered_at timestamptz
  );

  select coalesce(jsonb_agg(to_jsonb(inventory_row) order by inventory_row.created_at desc), '[]'::jsonb)
  into v_inventory
  from public.infrastructure_capacity_inventory as inventory_row
  where inventory_row.connection_id = v_connection.id
    and inventory_row.user_id = p_user_id;

  return jsonb_build_object(
    'connection', to_jsonb(v_connection),
    'inventory', v_inventory
  );
end;
$$;

create or replace function public.reconcile_hetzner_cloud_inventory(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_discovered_at timestamptz,
  p_inventory jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_inventory jsonb;
begin
  if jsonb_typeof(coalesce(p_inventory, '[]'::jsonb)) <> 'array' then
    raise exception 'Hetzner inventory must be an array' using errcode = '22023';
  end if;

  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and revision = p_expected_revision
  for update;

  if not found then
    return null;
  end if;

  -- `p_discovered_at` is the server-issued refresh generation captured before
  -- provider I/O. Concurrent refreshes share the same connection revision, so
  -- the revision guard alone cannot stop an older slow response from replacing
  -- a newer snapshot. Reject equal or older generations while holding the row
  -- lock; same-millisecond refreshes fail closed rather than racing.
  if v_connection.last_checked_at is not null
     and p_discovered_at <= v_connection.last_checked_at then
    return null;
  end if;

  insert into public.infrastructure_capacity_inventory (
    user_id,
    connection_id,
    provider,
    provider_resource_id,
    name,
    provider_status,
    server_type,
    location,
    public_network,
    provider_created_at,
    discovered_at
  )
  select
    p_user_id,
    p_connection_id,
    'hetzner-cloud',
    item.provider_resource_id,
    item.name,
    item.provider_status,
    item.server_type,
    item.location,
    item.public_network,
    item.provider_created_at,
    item.discovered_at
  from jsonb_to_recordset(coalesce(p_inventory, '[]'::jsonb)) as item(
    provider_resource_id text,
    name text,
    provider_status text,
    server_type jsonb,
    location jsonb,
    public_network jsonb,
    provider_created_at timestamptz,
    discovered_at timestamptz
  )
  on conflict (connection_id, provider_resource_id) do update
  set name = excluded.name,
      provider_status = excluded.provider_status,
      server_type = excluded.server_type,
      location = excluded.location,
      public_network = excluded.public_network,
      provider_created_at = excluded.provider_created_at,
      discovered_at = excluded.discovered_at;

  delete from public.infrastructure_capacity_inventory as existing
  where existing.connection_id = p_connection_id
    and existing.user_id = p_user_id
    and not exists (
      select 1
      from jsonb_to_recordset(coalesce(p_inventory, '[]'::jsonb)) as current_item(
        provider_resource_id text
      )
      where current_item.provider_resource_id = existing.provider_resource_id
    );

  update public.infrastructure_connections
  set status = 'ready',
      last_checked_at = p_discovered_at,
      last_error_code = null
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and revision = p_expected_revision;

  select coalesce(jsonb_agg(to_jsonb(inventory_row) order by inventory_row.created_at desc), '[]'::jsonb)
  into v_inventory
  from public.infrastructure_capacity_inventory as inventory_row
  where inventory_row.connection_id = p_connection_id
    and inventory_row.user_id = p_user_id;

  return v_inventory;
end;
$$;

-- Preserve the last successful inventory as stale evidence, while recording
-- that the newest provider observation failed. The timestamp guard prevents a
-- slow, older failure from overwriting a newer successful refresh.
create or replace function public.record_hetzner_cloud_inventory_failure(
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
  if p_last_error_code not in (
    'invalid_credentials',
    'provider_unavailable',
    'provider_response_invalid'
  ) then
    raise exception 'Invalid Hetzner Cloud observation error'
      using errcode = '22023';
  end if;

  update public.infrastructure_connections
  set status = 'error',
      last_checked_at = p_checked_at,
      last_error_code = p_last_error_code
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and revision = p_expected_revision
    and (last_checked_at is null or p_checked_at > last_checked_at);
  v_updated := found;

  return v_updated;
end;
$$;

revoke all on function public.create_hetzner_cloud_infrastructure_connection(
  text, text, text, smallint, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.reconcile_hetzner_cloud_inventory(
  text, uuid, bigint, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.record_hetzner_cloud_inventory_failure(
  text, uuid, bigint, timestamptz, text
) from public, anon, authenticated;

grant execute on function public.create_hetzner_cloud_infrastructure_connection(
  text, text, text, smallint, timestamptz, jsonb
) to service_role;
grant execute on function public.reconcile_hetzner_cloud_inventory(
  text, uuid, bigint, timestamptz, jsonb
) to service_role;
grant execute on function public.record_hetzner_cloud_inventory_failure(
  text, uuid, bigint, timestamptz, text
) to service_role;

comment on table public.infrastructure_capacity_inventory is
  'Owner-scoped, sanitized provider capacity inventory. The provider is part of the owner connection foreign key. Rows are informational and never deployment-target or launch authority.';

comment on function public.create_hetzner_cloud_infrastructure_connection(
  text, text, text, smallint, timestamptz, jsonb
) is
  'Atomically persists a validated Hetzner Cloud connection, encrypted project token envelope, and sanitized existing-server inventory without creating provider resources.';

comment on function public.reconcile_hetzner_cloud_inventory(
  text, uuid, bigint, timestamptz, jsonb
) is
  'Reconciles one exact owner-scoped Hetzner project inventory revision without publishing launch authority.';

comment on function public.record_hetzner_cloud_inventory_failure(
  text, uuid, bigint, timestamptz, text
) is
  'Records one monotonic failed Hetzner project observation while preserving the prior inventory as visibly stale evidence.';
