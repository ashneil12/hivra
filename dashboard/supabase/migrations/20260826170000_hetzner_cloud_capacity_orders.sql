-- Owner-scoped quote/idempotency ledger for explicit Hetzner Cloud server
-- creation. The per-order SSH private key is encrypted by the application and
-- this table is deliberately service-role-only. Durable rows retain audit
-- identity while connection deletion immediately detaches them and wipes the
-- encrypted bootstrap credential.

create or replace function public.is_valid_hetzner_action_receipts(
  p_actions jsonb,
  p_require_success boolean
)
returns boolean
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select jsonb_typeof(p_actions) = 'array'
    and jsonb_array_length(p_actions) <= 8
    and not exists (
      select 1
      from jsonb_array_elements(p_actions) as receipt(value)
      where jsonb_typeof(receipt.value) <> 'object'
         or not (
           receipt.value ? 'id'
           and receipt.value ? 'command'
           and receipt.value ? 'status'
         )
         or coalesce(
           case
             when jsonb_typeof(receipt.value) = 'object' then (
               select count(*)
               from jsonb_object_keys(receipt.value)
             ) <> 3
             else true
           end,
           true
         )
         or receipt.value->>'id' !~ '^[1-9][0-9]*$'
         or receipt.value->>'command' !~ '^[a-z][a-z0-9_]{0,63}$'
         or receipt.value->>'command' in ('poweron', 'start_resource')
         or receipt.value->>'status' not in ('running', 'success', 'error')
         or (p_require_success and receipt.value->>'status' <> 'success')
    )
    and (
      select count(*) from jsonb_array_elements(p_actions)
    ) = (
      select count(distinct receipt.value->>'id')
      from jsonb_array_elements(p_actions) as receipt(value)
    );
$$;

-- New Hetzner connections use an application-generated ID so the encrypted
-- provider-token envelope can be bound to owner + connection + revision before
-- either row is persisted. The older v1 RPC remains defined for migration
-- history but loses service-role execute below.
create or replace function public.create_hetzner_cloud_infrastructure_connection_v2(
  p_connection_id uuid,
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
  if p_connection_id is null
     or p_key_version <> 2
     or p_encrypted_bundle is null
     or btrim(p_encrypted_bundle) = '' then
    raise exception 'Invalid bound Hetzner credential envelope' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_inventory, '[]'::jsonb)) <> 'array' then
    raise exception 'Hetzner inventory must be an array' using errcode = '22023';
  end if;

  insert into public.infrastructure_connections (
    id, user_id, name, provider, operating_mode, setup_mode, status,
    ssh_host, ssh_port, ssh_user, ssh_host_fingerprint_sha256, config,
    revision, last_checked_at, last_error_code
  ) values (
    p_connection_id, p_user_id, p_name, 'hetzner-cloud', 'self-managed',
    'simple', 'ready', null, null, null, null, '{}'::jsonb,
    1, p_discovered_at, null
  )
  returning * into v_connection;

  insert into public.infrastructure_connection_secrets (
    connection_id, user_id, encrypted_bundle, key_version
  ) values (
    p_connection_id, p_user_id, p_encrypted_bundle, p_key_version
  );

  insert into public.infrastructure_capacity_inventory (
    user_id, connection_id, provider, provider_resource_id, name,
    provider_status, server_type, location, public_network,
    provider_created_at, discovered_at
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
  );

  select coalesce(
    jsonb_agg(to_jsonb(inventory_row) order by inventory_row.created_at desc),
    '[]'::jsonb
  )
  into v_inventory
  from public.infrastructure_capacity_inventory as inventory_row
  where inventory_row.connection_id = p_connection_id
    and inventory_row.user_id = p_user_id;

  return jsonb_build_object(
    'connection', to_jsonb(v_connection),
    'inventory', v_inventory
  );
end;
$$;

create table if not exists public.infrastructure_capacity_orders (
  id                               uuid        primary key default gen_random_uuid(),
  user_id                          text        not null check (btrim(user_id) <> ''),
  connection_id                    uuid        not null,
  active_connection_id             uuid,
  connection_revision              bigint      not null check (connection_revision > 0),
  provider                         text        not null default 'hetzner-cloud'
                                               check (provider = 'hetzner-cloud'),
  status                           text        not null default 'quoted'
                                               check (
                                                 status in (
                                                   'quoted', 'creating', 'created_off',
                                                   'ambiguous', 'provider_rejected'
                                                 )
                                               ),
  server_name                      text        not null
                                               check (
                                                 server_name ~ '^hivra-[0-9a-f]{20}$'
                                               ),
  provider_labels                  jsonb       not null
                                               check (jsonb_typeof(provider_labels) = 'object'),
  quote_snapshot                   jsonb       not null
                                               check (jsonb_typeof(quote_snapshot) = 'object'),
  quote_fingerprint_sha256         text        not null
                                               check (quote_fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  quote_expires_at                 timestamptz not null,
  idempotency_key                  uuid,
  encrypted_bootstrap_bundle       text,
  bootstrap_key_version            smallint,
  bootstrap_public_key             text,
  bootstrap_public_key_fingerprint text        check (
                                                 bootstrap_public_key_fingerprint is null
                                                 or bootstrap_public_key_fingerprint
                                                   ~ '^SHA256:[A-Za-z0-9+/]{43}$'
                                               ),
  ssh_key_post_attempted_at        timestamptz,
  provider_ssh_key_status          text        check (
                                                 provider_ssh_key_status is null
                                                 or provider_ssh_key_status in (
                                                   'pending', 'accepted', 'ambiguous', 'rejected'
                                                 )
                                               ),
  provider_ssh_key_id              text        check (
                                                 provider_ssh_key_id is null
                                                 or provider_ssh_key_id ~ '^[1-9][0-9]*$'
                                               ),
  server_post_attempted_at         timestamptz,
  provider_server_status           text        check (
                                                 provider_server_status is null
                                                 or provider_server_status in (
                                                   'pending', 'accepted', 'ambiguous'
                                                 )
                                               ),
  provider_resource_id             text        check (
                                                 provider_resource_id is null
                                                 or provider_resource_id ~ '^[1-9][0-9]*$'
                                               ),
  provider_action_id               text        check (
                                                 provider_action_id is null
                                                 or provider_action_id ~ '^[1-9][0-9]*$'
                                               ),
  provider_action_command          text        check (
                                                 provider_action_command is null
                                                 or provider_action_command ~ '^[a-z][a-z0-9_]{0,63}$'
                                               ),
  provider_action_status           text        check (
                                                 provider_action_status is null
                                                 or provider_action_status in ('running', 'success', 'error')
                                               ),
  provider_next_actions            jsonb       not null default '[]'::jsonb
                                               check (
                                                 public.is_valid_hetzner_action_receipts(
                                                   provider_next_actions,
                                                   false
                                                 )
                                               ),
  observed_server_status           text        check (
                                                 observed_server_status is null
                                                 or observed_server_status in (
                                                   'running', 'off', 'initializing', 'starting',
                                                   'stopping', 'deleting', 'rebuilding', 'migrating',
                                                   'unknown'
                                                 )
                                               ),
  provider_observed_at             timestamptz,
  last_error_code                  text        check (
                                                 last_error_code is null
                                                 or last_error_code in (
                                                   'selection_invalid', 'quote_expired', 'quote_changed',
                                                   'connection_changed', 'idempotency_conflict',
                                                   'canary_capacity_limit',
                                                   'quote_rate_limited',
                                                   'credential_reconnect_required',
                                                   'invalid_credentials', 'token_read_only',
                                                   'provider_forbidden', 'provider_resource_limit',
                                                   'provider_maintenance', 'provider_rate_limited',
                                                   'provider_conflict', 'provider_unavailable',
                                                   'provider_response_invalid', 'provider_action_failed',
                                                   'access_setup_failed'
                                                 )
                                               ),
  detached_at                      timestamptz,
  created_at                       timestamptz not null default now(),
  updated_at                       timestamptz not null default now(),
  constraint infrastructure_capacity_orders_owner_connection_fk
    foreign key (active_connection_id, user_id, provider)
    references public.infrastructure_connections (id, user_id, provider)
    on delete set null (active_connection_id),
  constraint infrastructure_capacity_orders_active_binding_check
    check (
      active_connection_id is null
      or active_connection_id = connection_id
    ),
  constraint infrastructure_capacity_orders_secret_state_check
    check (
      (
        status = 'quoted'
        and active_connection_id is not null
        and idempotency_key is null
        and encrypted_bootstrap_bundle is null
        and bootstrap_key_version is null
        and bootstrap_public_key is null
        and bootstrap_public_key_fingerprint is null
      )
      or
      (
        status in ('creating', 'created_off', 'ambiguous')
        and active_connection_id is not null
        and idempotency_key is not null
        and encrypted_bootstrap_bundle is not null
        and bootstrap_key_version = 2
        and bootstrap_public_key is not null
        and bootstrap_public_key_fingerprint is not null
      )
      or
      (
        status = 'provider_rejected'
        and active_connection_id is not null
        and idempotency_key is not null
        and server_post_attempted_at is null
        and encrypted_bootstrap_bundle is null
        and bootstrap_key_version is null
      )
      or
      (
        status <> 'quoted'
        and active_connection_id is null
        and detached_at is not null
        and idempotency_key is not null
        and encrypted_bootstrap_bundle is null
        and bootstrap_key_version is null
      )
    ),
  constraint infrastructure_capacity_orders_attempt_state_check
    check (
      (ssh_key_post_attempted_at is null and provider_ssh_key_status is null)
      or (ssh_key_post_attempted_at is not null and provider_ssh_key_status is not null)
    ),
  constraint infrastructure_capacity_orders_ssh_result_check
    check (
      provider_ssh_key_status <> 'accepted'
      or provider_ssh_key_id is not null
    ),
  constraint infrastructure_capacity_orders_server_attempt_state_check
    check (
      (
        server_post_attempted_at is null
        and provider_server_status is null
        and provider_resource_id is null
      )
      or (
        server_post_attempted_at is not null
        and provider_server_status is not null
        and (
          provider_resource_id is null
          or provider_server_status = 'accepted'
        )
      )
    ),
  constraint infrastructure_capacity_orders_created_off_check
    check (
      status <> 'created_off'
      or (
        provider_resource_id is not null
        and provider_action_id is not null
        and provider_action_command = 'create_server'
        and provider_action_status = 'success'
        and public.is_valid_hetzner_action_receipts(
          provider_next_actions,
          true
        )
        and observed_server_status = 'off'
        and provider_observed_at is not null
        and provider_ssh_key_status = 'accepted'
        and provider_ssh_key_id is not null
        and server_post_attempted_at is not null
        and provider_server_status = 'accepted'
        and last_error_code is null
      )
    ),
  constraint infrastructure_capacity_orders_rejected_no_resource_check
    check (
      status <> 'provider_rejected'
      or (provider_resource_id is null and last_error_code is not null)
    )
);

create unique index if not exists infrastructure_capacity_orders_owner_idempotency_idx
  on public.infrastructure_capacity_orders (user_id, connection_id, idempotency_key)
  where idempotency_key is not null;

-- Canary simple mode deliberately permits one non-rejected Hivra-created
-- server per owner across connections. This is a durable total-spend backstop; a process
-- local rate limiter cannot enforce a purchase budget in serverless runtimes.
create unique index if not exists infrastructure_capacity_orders_one_capacity_idx
  on public.infrastructure_capacity_orders (user_id)
  where status in ('creating', 'ambiguous', 'created_off')
     or provider_ssh_key_id is not null;

create index if not exists infrastructure_capacity_orders_owner_connection_idx
  on public.infrastructure_capacity_orders (user_id, connection_id, created_at desc);

drop trigger if exists infrastructure_capacity_orders_updated_at
  on public.infrastructure_capacity_orders;
create trigger infrastructure_capacity_orders_updated_at
  before update on public.infrastructure_capacity_orders
  for each row execute function public.update_updated_at();

alter table public.infrastructure_capacity_orders enable row level security;
revoke all on public.infrastructure_capacity_orders from public, anon, authenticated;
grant all on public.infrastructure_capacity_orders to service_role;

-- Quote requests perform several live provider reads before persistence, so a
-- durable owner-scoped cap prevents unbounded unclaimed ledger growth even
-- across serverless processes. Expired, never-claimed quotes carry no audit or
-- provider-resource evidence and are purged before enforcing the cap.
create or replace function public.create_hetzner_cloud_capacity_quote(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_quote_id uuid,
  p_server_name text,
  p_provider_labels jsonb,
  p_quote_snapshot jsonb,
  p_quote_fingerprint_sha256 text,
  p_quote_expires_at timestamptz,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_order public.infrastructure_capacity_orders%rowtype;
  v_active_quote_count integer;
begin
  if p_user_id is null
     or btrim(p_user_id) = ''
     or p_quote_id is null
     or p_server_name !~ '^hivra-[0-9a-f]{20}$'
     or jsonb_typeof(p_provider_labels) <> 'object'
     or coalesce(
       case
         when jsonb_typeof(p_provider_labels) = 'object' then (
           select count(*)
           from jsonb_object_keys(p_provider_labels)
         ) <> 3
         else true
       end,
       true
     )
     or p_provider_labels->>'hivra-operation' <> p_quote_id::text
     or p_provider_labels->>'hivra-managed' <> 'true'
     or p_provider_labels->>'hivra-quote'
          <> left(p_quote_fingerprint_sha256, 32)
     or jsonb_typeof(p_quote_snapshot) <> 'object'
     or p_quote_snapshot->>'id' <> p_quote_id::text
     or p_quote_snapshot->>'connectionId' <> p_connection_id::text
     or (p_quote_snapshot->>'connectionRevision')::bigint <> p_expected_revision
     or p_quote_snapshot->>'serverName' <> p_server_name
     or p_quote_fingerprint_sha256 !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_quote_expires_at is null
     or p_quote_expires_at <= p_now then
    raise exception 'Invalid Hetzner capacity quote binding' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('hivra-hetzner-capacity-quote:' || p_user_id, 0)
  );

  delete from public.infrastructure_capacity_orders
  where user_id = p_user_id
    and status = 'quoted'
    and idempotency_key is null
    and quote_expires_at <= p_now;

  select count(*) into v_active_quote_count
  from public.infrastructure_capacity_orders
  where user_id = p_user_id
    and status = 'quoted'
    and idempotency_key is null
    and quote_expires_at > p_now;
  if v_active_quote_count >= 5 then
    return jsonb_build_object('outcome', 'quote_rate_limited');
  end if;

  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and status = 'ready'
    and revision = p_expected_revision
  for update;
  if not found then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;

  insert into public.infrastructure_capacity_orders (
    id, user_id, connection_id, active_connection_id, connection_revision,
    provider, status, server_name, provider_labels, quote_snapshot,
    quote_fingerprint_sha256, quote_expires_at
  ) values (
    p_quote_id, p_user_id, p_connection_id, p_connection_id,
    p_expected_revision, 'hetzner-cloud', 'quoted', p_server_name,
    p_provider_labels, p_quote_snapshot, p_quote_fingerprint_sha256,
    p_quote_expires_at
  )
  returning * into v_order;

  return jsonb_build_object('outcome', 'created', 'order', to_jsonb(v_order));
end;
$$;

create or replace function public.claim_hetzner_cloud_capacity_order(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_quote_id uuid,
  p_idempotency_key uuid,
  p_encrypted_bootstrap_bundle text,
  p_bootstrap_key_version smallint,
  p_bootstrap_public_key text,
  p_bootstrap_public_key_fingerprint text,
  p_now timestamptz
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_existing public.infrastructure_capacity_orders%rowtype;
  v_order public.infrastructure_capacity_orders%rowtype;
  v_connection public.infrastructure_connections%rowtype;
begin
  select * into v_existing
  from public.infrastructure_capacity_orders
  where user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and provider = 'hetzner-cloud'
    and idempotency_key = p_idempotency_key
  for update;

  if found then
    if v_existing.id <> p_quote_id then
      return jsonb_build_object('outcome', 'idempotency_conflict');
    end if;
    return jsonb_build_object(
      'outcome', 'replay',
      'execute', false,
      'order', to_jsonb(v_existing)
    );
  end if;

  select * into v_order
  from public.infrastructure_capacity_orders
  where id = p_quote_id
    and user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and provider = 'hetzner-cloud'
  for update;

  if not found then
    return jsonb_build_object('outcome', 'not_found');
  end if;
  if v_order.quote_expires_at <= p_now then
    return jsonb_build_object('outcome', 'quote_expired');
  end if;
  if v_order.status <> 'quoted' or v_order.idempotency_key is not null then
    return jsonb_build_object('outcome', 'idempotency_conflict');
  end if;
  if v_order.connection_revision <> p_expected_revision then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;

  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and status = 'ready'
    and revision = p_expected_revision
  for update;
  if not found then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;

  if p_bootstrap_key_version <> 2
     or p_encrypted_bootstrap_bundle is null
     or btrim(p_encrypted_bootstrap_bundle) = ''
     or p_bootstrap_public_key !~ '^ssh-ed25519 [A-Za-z0-9+/]+={0,2} hivra-capacity$'
     or p_bootstrap_public_key_fingerprint
          !~ '^SHA256:[A-Za-z0-9+/]{43}$' then
    raise exception 'Invalid encrypted bootstrap bundle' using errcode = '22023';
  end if;

  update public.infrastructure_capacity_orders
  set status = 'creating',
      idempotency_key = p_idempotency_key,
      encrypted_bootstrap_bundle = p_encrypted_bootstrap_bundle,
      bootstrap_key_version = p_bootstrap_key_version,
      bootstrap_public_key = p_bootstrap_public_key,
      bootstrap_public_key_fingerprint = p_bootstrap_public_key_fingerprint,
      last_error_code = null
  where id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'outcome', 'claimed',
    'execute', true,
    'order', to_jsonb(v_order)
  );
exception
  when unique_violation then
    return jsonb_build_object('outcome', 'canary_capacity_limit');
end;
$$;

create or replace function public.mark_hetzner_cloud_ssh_key_post_attempted(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_attempted_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.infrastructure_capacity_orders as capacity_order
  set ssh_key_post_attempted_at = p_attempted_at,
      provider_ssh_key_status = 'pending'
  where capacity_order.id = p_order_id
    and capacity_order.user_id = p_user_id
    and capacity_order.connection_id = p_connection_id
    and capacity_order.active_connection_id = p_connection_id
    and capacity_order.connection_revision = p_expected_revision
    and capacity_order.provider = 'hetzner-cloud'
    and capacity_order.idempotency_key = p_idempotency_key
    and capacity_order.status = 'creating'
    and capacity_order.ssh_key_post_attempted_at is null
    and exists (
      select 1 from public.infrastructure_connections as connection
      where connection.id = p_connection_id
        and connection.user_id = p_user_id
        and connection.provider = 'hetzner-cloud'
        and connection.status = 'ready'
        and connection.revision = p_expected_revision
    );
  v_updated := found;
  return v_updated;
end;
$$;

create or replace function public.record_hetzner_cloud_ssh_key_result(
  p_user_id text,
  p_connection_id uuid,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_status text,
  p_provider_ssh_key_id text,
  p_last_error_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order public.infrastructure_capacity_orders%rowtype;
begin
  if p_status not in ('accepted', 'ambiguous', 'rejected') then
    raise exception 'Invalid SSH key result status' using errcode = '22023';
  end if;
  if p_status = 'accepted' and (
    p_provider_ssh_key_id is null
    or p_provider_ssh_key_id !~ '^[1-9][0-9]*$'
    or p_last_error_code is not null
  ) then
    raise exception 'Accepted SSH key result is incomplete' using errcode = '22023';
  end if;
  if p_status <> 'accepted' and p_last_error_code is null then
    raise exception 'Failed SSH key result needs an error code' using errcode = '22023';
  end if;

  update public.infrastructure_capacity_orders
  set provider_ssh_key_status = p_status,
      provider_ssh_key_id = case
        when p_status = 'accepted' then p_provider_ssh_key_id
        else provider_ssh_key_id
      end,
      status = case
        when p_status = 'accepted' then 'creating'
        when p_status = 'ambiguous' then 'ambiguous'
        when p_status = 'rejected' then 'provider_rejected'
      end,
      encrypted_bootstrap_bundle = case
        when p_status = 'rejected' then null
        else encrypted_bootstrap_bundle
      end,
      bootstrap_key_version = case
        when p_status = 'rejected' then null
        else bootstrap_key_version
      end,
      last_error_code = p_last_error_code
  where id = p_order_id
    and user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and provider = 'hetzner-cloud'
    and idempotency_key = p_idempotency_key
    and ssh_key_post_attempted_at is not null
    and (
      (status = 'creating' and provider_ssh_key_status = 'pending')
      or (
        p_status = 'accepted'
        and status = 'ambiguous'
        and provider_ssh_key_status = 'ambiguous'
        and server_post_attempted_at is null
      )
      or (
        p_status = 'ambiguous'
        and status = 'ambiguous'
        and provider_ssh_key_status = 'ambiguous'
        and server_post_attempted_at is null
      )
    )
  returning * into v_order;

  if not found then return null; end if;
  return to_jsonb(v_order);
end;
$$;

create or replace function public.mark_hetzner_cloud_server_post_attempted(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_provider_ssh_key_id text,
  p_attempted_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_updated boolean := false;
begin
  update public.infrastructure_capacity_orders as capacity_order
  set server_post_attempted_at = p_attempted_at,
      provider_server_status = 'pending'
  where capacity_order.id = p_order_id
    and capacity_order.user_id = p_user_id
    and capacity_order.connection_id = p_connection_id
    and capacity_order.active_connection_id = p_connection_id
    and capacity_order.connection_revision = p_expected_revision
    and capacity_order.provider = 'hetzner-cloud'
    and capacity_order.idempotency_key = p_idempotency_key
    and capacity_order.status = 'creating'
    and capacity_order.provider_ssh_key_status = 'accepted'
    and capacity_order.provider_ssh_key_id = p_provider_ssh_key_id
    and capacity_order.server_post_attempted_at is null
    and exists (
      select 1 from public.infrastructure_connections as connection
      where connection.id = p_connection_id
        and connection.user_id = p_user_id
        and connection.provider = 'hetzner-cloud'
        and connection.status = 'ready'
        and connection.revision = p_expected_revision
    );
  v_updated := found;
  return v_updated;
end;
$$;

create or replace function public.record_hetzner_cloud_capacity_order_progress(
  p_user_id text,
  p_connection_id uuid,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_provider_resource_id text,
  p_provider_action_id text,
  p_provider_action_command text,
  p_provider_action_status text,
  p_provider_next_actions jsonb,
  p_provider_observed_at timestamptz,
  p_observed_server_status text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order public.infrastructure_capacity_orders%rowtype;
begin
  if p_provider_resource_id !~ '^[1-9][0-9]*$'
     or p_provider_action_id !~ '^[1-9][0-9]*$'
     or p_provider_action_command <> 'create_server'
     or p_provider_action_status not in ('running', 'success', 'error') then
    raise exception 'Invalid provider progress' using errcode = '22023';
  end if;
  if (p_provider_observed_at is null) <> (p_observed_server_status is null) then
    raise exception 'Provider observation timestamp mismatch' using errcode = '22023';
  end if;
  if not public.is_valid_hetzner_action_receipts(
       p_provider_next_actions,
       false
     )
     or exists (
       select 1 from jsonb_array_elements(p_provider_next_actions) as action(value)
       where action.value->>'id' = p_provider_action_id
     ) then
    raise exception 'Invalid provider next actions' using errcode = '22023';
  end if;

  update public.infrastructure_capacity_orders
  set provider_resource_id = p_provider_resource_id,
      provider_server_status = 'accepted',
      provider_action_id = p_provider_action_id,
      provider_action_command = p_provider_action_command,
      provider_action_status = p_provider_action_status,
      provider_next_actions = p_provider_next_actions,
      observed_server_status = coalesce(p_observed_server_status, observed_server_status),
      provider_observed_at = case
        when p_observed_server_status is not null then p_provider_observed_at
        else provider_observed_at
      end,
      last_error_code = case
        when status = 'ambiguous' then last_error_code
        else null
      end
  where id = p_order_id
    and user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and provider = 'hetzner-cloud'
    and idempotency_key = p_idempotency_key
    and status in ('creating', 'ambiguous')
    and provider_ssh_key_status = 'accepted'
    and server_post_attempted_at is not null
    and (provider_resource_id is null or provider_resource_id = p_provider_resource_id)
    and (provider_action_id is null or provider_action_id = p_provider_action_id)
    and (
      provider_action_command is null
      or provider_action_command = p_provider_action_command
    )
    and (
      provider_action_status is null
      or provider_action_status = p_provider_action_status
      or (
        provider_action_status = 'running'
        and p_provider_action_status in ('success', 'error')
      )
    )
    and (
      p_provider_observed_at is null
      or provider_observed_at is null
      or p_provider_observed_at >= provider_observed_at
    )
    and (
      observed_server_status is null
      or observed_server_status not in ('running', 'starting', 'unknown')
      or p_observed_server_status = observed_server_status
    )
    and (
      provider_next_actions = '[]'::jsonb
      or (
        jsonb_array_length(provider_next_actions)
          = jsonb_array_length(p_provider_next_actions)
        and not exists (
          select 1
          from jsonb_to_recordset(provider_next_actions) as old_action(
            id text, command text, status text
          )
          where not exists (
            select 1
            from jsonb_to_recordset(p_provider_next_actions) as new_action(
              id text, command text, status text
            )
            where new_action.id = old_action.id
              and new_action.command = old_action.command
              and (
                new_action.status = old_action.status
                or (
                  old_action.status = 'running'
                  and new_action.status in ('success', 'error')
                )
              )
          )
        )
      )
    )
  returning * into v_order;

  if not found then return null; end if;
  return to_jsonb(v_order);
end;
$$;

create or replace function public.record_hetzner_cloud_capacity_order_result(
  p_user_id text,
  p_connection_id uuid,
  p_order_id uuid,
  p_idempotency_key uuid,
  p_status text,
  p_provider_resource_id text,
  p_provider_action_id text,
  p_provider_action_command text,
  p_provider_action_status text,
  p_provider_next_actions jsonb,
  p_provider_observed_at timestamptz,
  p_observed_server_status text,
  p_last_error_code text
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_order public.infrastructure_capacity_orders%rowtype;
begin
  if p_status not in ('created_off', 'ambiguous', 'provider_rejected') then
    raise exception 'Invalid capacity order result status' using errcode = '22023';
  end if;
  if p_status = 'created_off' and (
    p_provider_resource_id !~ '^[1-9][0-9]*$'
    or p_provider_action_id !~ '^[1-9][0-9]*$'
    or p_provider_action_command <> 'create_server'
    or p_provider_action_status <> 'success'
    or not public.is_valid_hetzner_action_receipts(
      p_provider_next_actions,
      true
    )
    or exists (
      select 1 from jsonb_array_elements(p_provider_next_actions) as action(value)
      where action.value->>'id' = p_provider_action_id
    )
    or p_observed_server_status <> 'off'
    or p_provider_observed_at is null
    or p_last_error_code is not null
  ) then
    raise exception 'Created-off result is incomplete' using errcode = '22023';
  end if;
  if p_status <> 'created_off' and p_last_error_code is null then
    raise exception 'Failed capacity result needs an error code' using errcode = '22023';
  end if;
  if (p_provider_observed_at is null) <> (p_observed_server_status is null) then
    raise exception 'Provider observation evidence must be complete' using errcode = '22023';
  end if;
  if (
    (p_provider_action_id is null) <> (p_provider_action_command is null)
    or (p_provider_action_id is null) <> (p_provider_action_status is null)
    or (
      p_provider_action_id is not null
      and (
        p_provider_action_id !~ '^[1-9][0-9]*$'
        or p_provider_action_command !~ '^[a-z][a-z0-9_]{0,63}$'
        or p_provider_action_status not in ('running', 'success', 'error')
      )
    )
  ) then
    raise exception 'Provider action evidence must be coherent' using errcode = '22023';
  end if;

  update public.infrastructure_capacity_orders
  set status = p_status,
      provider_resource_id = coalesce(p_provider_resource_id, provider_resource_id),
      provider_server_status = case
        when p_provider_resource_id is not null or provider_resource_id is not null
          then 'accepted'
        when p_status = 'ambiguous' and server_post_attempted_at is not null
          then 'ambiguous'
        else provider_server_status
      end,
      provider_action_id = coalesce(p_provider_action_id, provider_action_id),
      provider_action_command = coalesce(
        p_provider_action_command,
        provider_action_command
      ),
      provider_action_status = coalesce(p_provider_action_status, provider_action_status),
      provider_next_actions = case
        when p_status = 'created_off' then p_provider_next_actions
        else provider_next_actions
      end,
      encrypted_bootstrap_bundle = case
        when p_status = 'provider_rejected' then null
        else encrypted_bootstrap_bundle
      end,
      bootstrap_key_version = case
        when p_status = 'provider_rejected' then null
        else bootstrap_key_version
      end,
      observed_server_status = coalesce(p_observed_server_status, observed_server_status),
      provider_observed_at = case
        when p_observed_server_status is not null then p_provider_observed_at
        else provider_observed_at
      end,
      last_error_code = p_last_error_code
  where id = p_order_id
    and user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and provider = 'hetzner-cloud'
    and idempotency_key = p_idempotency_key
    and (
      (
        p_status = 'created_off'
        and status in ('creating', 'ambiguous')
        and provider_ssh_key_status = 'accepted'
        and server_post_attempted_at is not null
        and (provider_resource_id is null or provider_resource_id = p_provider_resource_id)
        and (provider_action_id is null or provider_action_id = p_provider_action_id)
        and provider_action_status is distinct from 'error'
        and (
          observed_server_status is null
          or observed_server_status not in ('running', 'starting', 'unknown')
        )
        and (
          provider_observed_at is null
          or p_provider_observed_at >= provider_observed_at
        )
        and (
          provider_action_command is null
          or provider_action_command = p_provider_action_command
        )
        and (
          provider_next_actions = '[]'::jsonb
          or (
            jsonb_array_length(provider_next_actions)
              = jsonb_array_length(p_provider_next_actions)
            and not exists (
              select 1
              from jsonb_to_recordset(provider_next_actions) as old_action(
                id text, command text, status text
              )
              where not exists (
                select 1
                from jsonb_to_recordset(p_provider_next_actions) as new_action(
                  id text, command text, status text
                )
                where new_action.id = old_action.id
                  and new_action.command = old_action.command
              )
            )
          )
        )
        and not jsonb_path_exists(
          provider_next_actions,
          '$[*] ? (@.status == "error")'
        )
      )
      or (
        p_status = 'ambiguous'
        and status in ('creating', 'ambiguous')
        and (
          p_provider_resource_id is null
          or provider_resource_id is null
          or provider_resource_id = p_provider_resource_id
        )
        and (
          p_provider_action_id is null
          or provider_action_id is null
          or provider_action_id = p_provider_action_id
        )
        and (
          p_provider_action_command is null
          or provider_action_command is null
          or provider_action_command = p_provider_action_command
        )
        and (
          p_provider_action_status is null
          or provider_action_status is null
          or provider_action_status = p_provider_action_status
          or (
            provider_action_status = 'running'
            and p_provider_action_status in ('success', 'error')
          )
        )
        and (
          p_provider_observed_at is null
          or provider_observed_at is null
          or p_provider_observed_at >= provider_observed_at
        )
        and (
          p_observed_server_status is null
          or observed_server_status is null
          or observed_server_status not in ('running', 'starting', 'unknown')
          or p_observed_server_status = observed_server_status
        )
      )
      or (
        p_status = 'provider_rejected'
        and status = 'creating'
        and server_post_attempted_at is null
        and provider_resource_id is null
        and p_provider_resource_id is null
      )
    )
  returning * into v_order;

  if not found then return null; end if;
  return to_jsonb(v_order);
end;
$$;

-- Replace the complete-snapshot reconciler with generation-aware row writes.
-- A full GET started before a targeted create observation may finish later;
-- it must neither overwrite nor delete that newer row.
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
  if not found then return null; end if;
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
      discovered_at = excluded.discovered_at
  where public.infrastructure_capacity_inventory.discovered_at
    < excluded.discovered_at;

  delete from public.infrastructure_capacity_inventory as existing
  where existing.connection_id = p_connection_id
    and existing.user_id = p_user_id
    and existing.discovered_at <= p_discovered_at
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

  select coalesce(
    jsonb_agg(to_jsonb(inventory_row) order by inventory_row.created_at desc),
    '[]'::jsonb
  )
  into v_inventory
  from public.infrastructure_capacity_inventory as inventory_row
  where inventory_row.connection_id = p_connection_id
    and inventory_row.user_id = p_user_id;

  return v_inventory;
end;
$$;

-- Targeted upsert for a single strictly fetched server. Unlike the complete
-- inventory reconciliation RPC, this function never deletes rows and is safe
-- for create/ambiguity reconciliation paths.
create or replace function public.upsert_hetzner_cloud_inventory_server(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_discovered_at timestamptz,
  p_server jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_inventory public.infrastructure_capacity_inventory%rowtype;
begin
  if jsonb_typeof(p_server) <> 'object' then
    raise exception 'Hetzner server must be an object' using errcode = '22023';
  end if;

  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and revision = p_expected_revision
  for update;
  if not found then return null; end if;
  if v_connection.last_checked_at is not null
     and p_discovered_at <= v_connection.last_checked_at then
    return null;
  end if;

  insert into public.infrastructure_capacity_inventory (
    user_id, connection_id, provider, provider_resource_id, name,
    provider_status, server_type, location, public_network,
    provider_created_at, discovered_at
  ) values (
    p_user_id,
    p_connection_id,
    'hetzner-cloud',
    p_server->>'provider_resource_id',
    p_server->>'name',
    p_server->>'provider_status',
    p_server->'server_type',
    p_server->'location',
    p_server->'public_network',
    (p_server->>'provider_created_at')::timestamptz,
    p_discovered_at
  )
  on conflict (connection_id, provider_resource_id) do update
  set name = excluded.name,
      provider_status = excluded.provider_status,
      server_type = excluded.server_type,
      location = excluded.location,
      public_network = excluded.public_network,
      provider_created_at = excluded.provider_created_at,
      discovered_at = excluded.discovered_at
  where public.infrastructure_capacity_inventory.discovered_at
    < excluded.discovered_at
  returning * into v_inventory;

  if not found then return null; end if;

  update public.infrastructure_connections
  set status = 'ready',
      last_checked_at = p_discovered_at,
      last_error_code = null
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
    and revision = p_expected_revision;

  return to_jsonb(v_inventory);
end;
$$;

-- Generic deletion is intentionally unavailable once a provider mutation has
-- an ambiguous outcome. The owner must use the separately confirmed
-- force-forget path, which never claims that provider resources were cleaned.
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

  if v_connection.provider = 'hetzner-cloud' then
    -- Serialize against every attached order before deciding whether the
    -- credential can be revoked. `creating` and every post-attempt ambiguous
    -- outcome stay blocked here permanently; timestamp expiry is authority for
    -- bounded reconciliation, never authority for generic credential deletion.
    perform capacity_order.id
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
    order by capacity_order.id
    for update;

    if exists (
      select 1
      from public.infrastructure_capacity_orders as capacity_order
      where capacity_order.user_id = p_user_id
        and capacity_order.active_connection_id = p_connection_id
        and (
          capacity_order.status = 'creating'
          or capacity_order.provider_ssh_key_status = 'pending'
          or capacity_order.provider_server_status = 'pending'
          or (
            capacity_order.status = 'ambiguous'
            and (
              capacity_order.ssh_key_post_attempted_at
                >= now() - interval '60 seconds'
              or capacity_order.server_post_attempted_at
                >= now() - interval '60 seconds'
            )
          )
        )
    ) then
      return 'capacity_busy';
    end if;

    if exists (
      select 1
      from public.infrastructure_capacity_orders as capacity_order
      where capacity_order.user_id = p_user_id
        and capacity_order.active_connection_id = p_connection_id
        and capacity_order.status = 'ambiguous'
        and (
          capacity_order.ssh_key_post_attempted_at is not null
          or capacity_order.server_post_attempted_at is not null
        )
    ) then
      return 'capacity_force_forget_required';
    end if;

    delete from public.infrastructure_capacity_orders
    where user_id = p_user_id
      and connection_id = p_connection_id
      and (
        status = 'quoted'
        or (
          status = 'provider_rejected'
          and provider_resource_id is null
          and provider_ssh_key_id is null
        )
      );

    update public.infrastructure_capacity_orders
    set active_connection_id = null,
        detached_at = now(),
        encrypted_bootstrap_bundle = null,
        bootstrap_key_version = null
    where user_id = p_user_id
      and connection_id = p_connection_id
      and active_connection_id = p_connection_id;
  end if;

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'deleted';
end;
$$;

-- Explicit Canary-only escape hatch for an owner who accepts that an idle
-- ambiguous provider operation may have left billable resources behind. This
-- never calls Hetzner, never frees the owner-wide Canary slot, never deletes
-- audit evidence, and never detaches a pending or creating mutation.
create or replace function public.force_forget_hetzner_cloud_connection(
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
  if v_connection.provider <> 'hetzner-cloud' then return 'invalid_provider'; end if;
  if v_connection.preflight_run_id is not null then return 'blocked'; end if;

  perform capacity_order.id
  from public.infrastructure_capacity_orders as capacity_order
  where capacity_order.user_id = p_user_id
    and capacity_order.active_connection_id = p_connection_id
  order by capacity_order.id
  for update;

  if exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and (
        capacity_order.status = 'creating'
        or capacity_order.provider_ssh_key_status = 'pending'
        or capacity_order.provider_server_status = 'pending'
        or (
          capacity_order.status = 'ambiguous'
          and greatest(
            coalesce(capacity_order.ssh_key_post_attempted_at, '-infinity'::timestamptz),
            coalesce(capacity_order.server_post_attempted_at, '-infinity'::timestamptz)
          ) >= now() - interval '60 seconds'
        )
      )
  ) then
    return 'capacity_busy';
  end if;

  if not exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and capacity_order.status = 'ambiguous'
      and (
        capacity_order.ssh_key_post_attempted_at is not null
        or capacity_order.server_post_attempted_at is not null
      )
      and capacity_order.provider_ssh_key_status is distinct from 'pending'
      and capacity_order.provider_server_status is distinct from 'pending'
  ) then
    return 'not_ambiguous';
  end if;

  if exists (
    select 1
    from public.infrastructure_capacity_orders as capacity_order
    where capacity_order.user_id = p_user_id
      and capacity_order.active_connection_id = p_connection_id
      and capacity_order.status not in ('quoted', 'ambiguous')
      and not (
        capacity_order.status = 'provider_rejected'
        and capacity_order.provider_resource_id is null
        and capacity_order.provider_ssh_key_id is null
      )
  ) then
    return 'not_ambiguous';
  end if;

  delete from public.infrastructure_capacity_orders
  where user_id = p_user_id
    and connection_id = p_connection_id
    and (
      status = 'quoted'
      or (
        status = 'provider_rejected'
        and provider_resource_id is null
        and provider_ssh_key_id is null
      )
    );

  update public.infrastructure_capacity_orders
  set active_connection_id = null,
      detached_at = now(),
      encrypted_bootstrap_bundle = null,
      bootstrap_key_version = null
  where user_id = p_user_id
    and connection_id = p_connection_id
    and active_connection_id = p_connection_id
    and status = 'ambiguous';

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'forgotten';
end;
$$;

revoke all on function public.claim_hetzner_cloud_capacity_order(
  text, uuid, bigint, uuid, uuid, text, smallint, text, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.create_hetzner_cloud_capacity_quote(
  text, uuid, bigint, uuid, text, jsonb, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
revoke all on function public.is_valid_hetzner_action_receipts(jsonb, boolean)
  from public, anon, authenticated;
revoke all on function public.mark_hetzner_cloud_ssh_key_post_attempted(
  text, uuid, bigint, uuid, uuid, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_hetzner_cloud_ssh_key_result(
  text, uuid, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke all on function public.mark_hetzner_cloud_server_post_attempted(
  text, uuid, bigint, uuid, uuid, text, timestamptz
) from public, anon, authenticated;
revoke all on function public.record_hetzner_cloud_capacity_order_progress(
  text, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, text
) from public, anon, authenticated;
revoke all on function public.record_hetzner_cloud_capacity_order_result(
  text, uuid, uuid, uuid, text, text, text, text, text, jsonb, timestamptz, text, text
) from public, anon, authenticated;
revoke all on function public.upsert_hetzner_cloud_inventory_server(
  text, uuid, bigint, timestamptz, jsonb
) from public, anon, authenticated;
revoke all on function public.delete_infrastructure_connection(text, uuid)
  from public, anon, authenticated;
revoke all on function public.force_forget_hetzner_cloud_connection(text, uuid)
  from public, anon, authenticated;
revoke all on function public.create_hetzner_cloud_infrastructure_connection(
  text, text, text, smallint, timestamptz, jsonb
) from service_role;
revoke all on function public.create_hetzner_cloud_infrastructure_connection_v2(
  uuid, text, text, text, smallint, timestamptz, jsonb
) from public, anon, authenticated;

grant execute on function public.claim_hetzner_cloud_capacity_order(
  text, uuid, bigint, uuid, uuid, text, smallint, text, text, timestamptz
) to service_role;
grant execute on function public.create_hetzner_cloud_capacity_quote(
  text, uuid, bigint, uuid, text, jsonb, jsonb, text, timestamptz, timestamptz
) to service_role;
grant execute on function public.is_valid_hetzner_action_receipts(jsonb, boolean)
  to service_role;
grant execute on function public.mark_hetzner_cloud_ssh_key_post_attempted(
  text, uuid, bigint, uuid, uuid, timestamptz
) to service_role;
grant execute on function public.record_hetzner_cloud_ssh_key_result(
  text, uuid, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.mark_hetzner_cloud_server_post_attempted(
  text, uuid, bigint, uuid, uuid, text, timestamptz
) to service_role;
grant execute on function public.record_hetzner_cloud_capacity_order_progress(
  text, uuid, uuid, uuid, text, text, text, text, jsonb, timestamptz, text
) to service_role;
grant execute on function public.record_hetzner_cloud_capacity_order_result(
  text, uuid, uuid, uuid, text, text, text, text, text, jsonb, timestamptz, text, text
) to service_role;
grant execute on function public.upsert_hetzner_cloud_inventory_server(
  text, uuid, bigint, timestamptz, jsonb
) to service_role;
grant execute on function public.delete_infrastructure_connection(text, uuid)
  to service_role;
grant execute on function public.force_forget_hetzner_cloud_connection(text, uuid)
  to service_role;
grant execute on function public.create_hetzner_cloud_infrastructure_connection_v2(
  uuid, text, text, text, smallint, timestamptz, jsonb
) to service_role;

comment on table public.infrastructure_capacity_orders is
  'Service-role-only owner/revision-scoped quote and exactly-once operation ledger. Encrypted bootstrap private keys are never browser-readable or agent-launch authority.';
