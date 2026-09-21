-- Owner-confirmed cleanup of a receipted, unprepared, powered-off server.
-- Keep original resource IDs as audit evidence. Only verified absence releases
-- the account claim and destroys the encrypted bootstrap credential.
alter table public.infrastructure_capacity_orders
  drop constraint infrastructure_capacity_orders_status_check,
  add constraint infrastructure_capacity_orders_status_check check (
    status in ('quoted', 'creating', 'created_off', 'ambiguous', 'provider_rejected', 'cleaning', 'deleted', 'cleanup_abandoned')
  ),
  add column cleanup_idempotency_key uuid,
  add column cleanup_resource_fingerprint text,
  add column cleanup_lease_id uuid,
  add column cleanup_lease_expires_at timestamptz,
  add column cleanup_absence jsonb,
  add column cleanup_last_error text,
  add column cleanup_started_at timestamptz,
  add column cleanup_observed_at timestamptz,
  add column cleanup_finished_at timestamptz,
  add column cleanup_abandoned_at timestamptz;

alter table public.infrastructure_capacity_orders
  drop constraint infrastructure_capacity_orders_secret_state_check,
  add constraint infrastructure_capacity_orders_secret_state_check check (
    (status = 'quoted' and active_connection_id is not null and idempotency_key is null
      and encrypted_bootstrap_bundle is null and bootstrap_key_version is null
      and bootstrap_public_key is null and bootstrap_public_key_fingerprint is null)
    or (status in ('creating', 'created_off', 'ambiguous', 'cleaning')
      and active_connection_id is not null and idempotency_key is not null
      and encrypted_bootstrap_bundle is not null and bootstrap_key_version = 2
      and bootstrap_public_key is not null and bootstrap_public_key_fingerprint is not null)
    or (status = 'provider_rejected' and active_connection_id is not null and idempotency_key is not null
      and server_post_attempted_at is null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
    or (status = 'deleted' and idempotency_key is not null
      and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
    or (status not in ('quoted', 'cleaning') and active_connection_id is null and detached_at is not null
      and idempotency_key is not null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null)
  ),
  add constraint infrastructure_capacity_orders_cleanup_state_check check (
    (status not in ('cleaning', 'deleted', 'cleanup_abandoned') and cleanup_idempotency_key is null
      and cleanup_resource_fingerprint is null and cleanup_lease_id is null
      and cleanup_lease_expires_at is null and cleanup_absence is null
      and cleanup_last_error is null and cleanup_started_at is null
      and cleanup_observed_at is null and cleanup_finished_at is null and cleanup_abandoned_at is null)
    or ((status in ('cleaning', 'deleted', 'cleanup_abandoned') and cleanup_idempotency_key is not null
      and cleanup_resource_fingerprint ~ '^[0-9a-f]{64}$'
      and cleanup_started_at is not null and provider_creation_receipt is not null
      and provider_ssh_key_id is not null and provider_ssh_key_status = 'accepted'
      and jsonb_typeof(cleanup_absence) = 'object'
      and cleanup_absence ?& array['server', 'ipv4', 'ipv6', 'sshKey']
      and (cleanup_absence - array['server', 'ipv4', 'ipv6', 'sshKey']) = '{}'::jsonb
      and jsonb_typeof(cleanup_absence->'server') = 'boolean'
      and jsonb_typeof(cleanup_absence->'ipv4') = 'boolean'
      and jsonb_typeof(cleanup_absence->'ipv6') = 'boolean'
      and jsonb_typeof(cleanup_absence->'sshKey') = 'boolean'
      and (cleanup_lease_id is null) = (cleanup_lease_expires_at is null)
      and (cleanup_last_error is null or cleanup_last_error in (
        'resource_changed', 'resource_busy', 'provider_unavailable', 'connection_changed'
      ))
      and ((status = 'cleaning' and cleanup_finished_at is null and cleanup_abandoned_at is null)
        or (status = 'deleted' and cleanup_finished_at is not null
          and cleanup_observed_at is not null and cleanup_lease_id is null
          and cleanup_last_error is null and cleanup_abandoned_at is null
          and cleanup_absence = '{"server":true,"ipv4":true,"ipv6":true,"sshKey":true}'::jsonb)
        or (status = 'cleanup_abandoned' and cleanup_finished_at is null
          and cleanup_abandoned_at is not null and active_connection_id is null and detached_at is not null
          and cleanup_lease_id is null and encrypted_bootstrap_bundle is null and bootstrap_key_version is null))) is true)
  );

drop index public.infrastructure_capacity_orders_one_capacity_idx;
create unique index infrastructure_capacity_orders_one_capacity_idx
  on public.infrastructure_capacity_orders(user_id)
  where status <> 'deleted' and (status in ('creating', 'ambiguous', 'created_off', 'cleaning')
    or provider_ssh_key_id is not null);

-- Freeze cleanup ownership and all original order evidence. Old creation RPCs
-- cannot resurrect a cleaning/deleted order or overwrite its resource set.
create or replace function public.guard_hetzner_cleanup_order()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_allowed text[];
begin
  if old.status not in ('cleaning', 'deleted', 'cleanup_abandoned') then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'Cleanup audit evidence cannot be deleted' using errcode = '55006';
  end if;
  v_allowed := array['updated_at'];
  if old.status = 'cleaning' then
    if new.status not in ('cleaning', 'deleted', 'cleanup_abandoned') then
      raise exception 'Cleanup cannot reactivate an order' using errcode = '55006';
    end if;
    v_allowed := v_allowed || array['status', 'cleanup_lease_id', 'cleanup_lease_expires_at',
      'cleanup_absence', 'cleanup_last_error', 'cleanup_observed_at', 'cleanup_finished_at'];
    if new.status in ('deleted', 'cleanup_abandoned') then
      v_allowed := v_allowed || array['encrypted_bootstrap_bundle', 'bootstrap_key_version'];
    end if;
    if new.status = 'cleanup_abandoned' then
      if old.cleanup_lease_expires_at > clock_timestamp() then
        raise exception 'Provider cleanup is still leased' using errcode = '55006';
      end if;
      v_allowed := v_allowed || array['active_connection_id','detached_at','cleanup_abandoned_at'];
    end if;
    if exists (select 1 from jsonb_each(old.cleanup_absence) x
      where x.value = 'true'::jsonb and new.cleanup_absence->x.key is distinct from 'true'::jsonb) then
      raise exception 'Verified absence cannot regress' using errcode = '22023';
    end if;
  elsif old.status = 'deleted' then
    -- A completed order may outlive a disconnected provider credential.
    if new.active_connection_id is null and new.detached_at is not null then
      v_allowed := v_allowed || array['active_connection_id', 'detached_at'];
    end if;
  end if;
  if (to_jsonb(old) - v_allowed) is distinct from (to_jsonb(new) - v_allowed) then
    raise exception 'Cleanup resource binding is immutable' using errcode = '55006';
  end if;
  return new;
end;
$$;
create trigger infrastructure_capacity_orders_cleanup_guard
  before update or delete on public.infrastructure_capacity_orders
  for each row execute function public.guard_hetzner_cleanup_order();

-- Serialize against provider credential revocation/rotation during cleanup,
-- including old disconnect RPCs. Read-only inventory timestamps may change.
create or replace function public.guard_hetzner_cleanup_connection()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.provider = 'hetzner-cloud' and exists (
    select 1 from public.infrastructure_capacity_orders
    where active_connection_id = old.id and user_id = old.user_id and status = 'cleaning'
  ) then
    if tg_op = 'DELETE' then
      raise exception 'Finish provider cleanup before disconnecting' using errcode = '55006';
    end if;
    if (to_jsonb(old) - array['updated_at','last_checked_at','last_error_code','status'])
      is distinct from (to_jsonb(new) - array['updated_at','last_checked_at','last_error_code','status']) then
      raise exception 'Provider credential is leased for cleanup' using errcode = '55006';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connections_cleanup_guard
  before update or delete on public.infrastructure_connections
  for each row execute function public.guard_hetzner_cleanup_connection();

create or replace function public.guard_hetzner_cleanup_secret()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform id from public.infrastructure_connections where id = old.connection_id for update;
  if exists (select 1 from public.infrastructure_capacity_orders
    where active_connection_id = old.connection_id and user_id = old.user_id and status = 'cleaning') then
    raise exception 'Provider credential is leased for cleanup' using errcode = '55006';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connection_secrets_cleanup_guard
  before update or delete on public.infrastructure_connection_secrets
  for each row execute function public.guard_hetzner_cleanup_secret();

-- Inventory RPCs take the connection lock, as does terminal cleanup. A late
-- pre-delete snapshot cannot recreate a verified-deleted resource in the UI.
create or replace function public.guard_hetzner_deleted_inventory()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.infrastructure_capacity_orders
    where user_id = new.user_id and connection_id = new.connection_id
      and provider_resource_id = new.provider_resource_id and status = 'deleted') then
    return null;
  end if;
  return new;
end;
$$;
create trigger infrastructure_capacity_inventory_deleted_guard
  before insert or update on public.infrastructure_capacity_inventory
  for each row execute function public.guard_hetzner_deleted_inventory();

create or replace function public.claim_hetzner_cleanup(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid,
  p_idempotency_key uuid, p_lease_id uuid, p_fingerprint text, p_server_name text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
begin
  if p_idempotency_key is null or p_lease_id is null or p_fingerprint is null
    or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid cleanup claim' using errcode = '22023';
  end if;
  perform id from public.infrastructure_connections where id = p_connection_id
    and user_id = p_user_id and provider = 'hetzner-cloud' and status = 'ready'
    and revision = p_expected_revision for update;
  if not found then return jsonb_build_object('outcome','connection_changed'); end if;
  select * into v_order from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and connection_id = p_connection_id and active_connection_id = p_connection_id
    and connection_revision = p_expected_revision for update;
  if not found then return jsonb_build_object('outcome','not_found'); end if;
  if v_order.server_name is distinct from p_server_name
    or v_order.provider_creation_receipt is null or v_order.provider_ssh_key_id is null
    or v_order.status not in ('created_off','cleaning','deleted') then
    return jsonb_build_object('outcome','not_eligible');
  end if;
  if v_order.cleanup_idempotency_key is not null and (
    v_order.cleanup_idempotency_key is distinct from p_idempotency_key
    or v_order.cleanup_resource_fingerprint is distinct from p_fingerprint
  ) then return jsonb_build_object('outcome','confirmation_changed'); end if;
  if v_order.status = 'deleted' then
    return jsonb_build_object('outcome','complete','order',to_jsonb(v_order));
  end if;
  if v_order.cleanup_lease_expires_at > clock_timestamp() then
    return jsonb_build_object('outcome','busy','order',to_jsonb(v_order));
  end if;
  update public.infrastructure_capacity_orders set status = 'cleaning',
    cleanup_idempotency_key = p_idempotency_key, cleanup_resource_fingerprint = p_fingerprint,
    cleanup_lease_id = p_lease_id, cleanup_lease_expires_at = clock_timestamp() + interval '120 seconds',
    cleanup_started_at = coalesce(cleanup_started_at, clock_timestamp()),
    cleanup_absence = coalesce(cleanup_absence, '{"server":false,"ipv4":false,"ipv6":false,"sshKey":false}'::jsonb)
    where id = p_order_id returning * into v_order;
  return jsonb_build_object('outcome','claimed','order',to_jsonb(v_order));
end;
$$;

create or replace function public.verify_hetzner_cleanup_lease(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid, p_lease_id uuid
)
returns boolean language sql security invoker set search_path = public, pg_temp as $$
  select exists (select 1 from public.infrastructure_capacity_orders o
    join public.infrastructure_connections c on c.id = o.active_connection_id and c.user_id = o.user_id
    where o.id = p_order_id and o.user_id = p_user_id and o.connection_id = p_connection_id
      and o.connection_revision = p_expected_revision and c.revision = p_expected_revision
      and c.status = 'ready' and o.status = 'cleaning' and o.cleanup_lease_id = p_lease_id
      and o.cleanup_lease_expires_at > clock_timestamp() + interval '30 seconds');
$$;

create or replace function public.record_hetzner_cleanup_observation(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint, p_order_id uuid,
  p_lease_id uuid, p_absence jsonb, p_error text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype; v_complete boolean;
begin
  perform id from public.infrastructure_connections where id = p_connection_id and user_id = p_user_id
    and provider = 'hetzner-cloud' and revision = p_expected_revision for update;
  if not found then return null; end if;
  select * into v_order from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and active_connection_id = p_connection_id
    and connection_revision = p_expected_revision and status = 'cleaning'
    and cleanup_lease_id = p_lease_id and cleanup_lease_expires_at > clock_timestamp() for update;
  if not found then return null; end if;
  v_complete := p_error is null and p_absence = '{"server":true,"ipv4":true,"ipv6":true,"sshKey":true}'::jsonb;
  update public.infrastructure_capacity_orders set
    cleanup_absence = p_absence, cleanup_last_error = p_error,
    cleanup_observed_at = clock_timestamp(), cleanup_lease_id = null, cleanup_lease_expires_at = null,
    status = case when v_complete then 'deleted' else 'cleaning' end,
    encrypted_bootstrap_bundle = case when v_complete then null else encrypted_bootstrap_bundle end,
    bootstrap_key_version = case when v_complete then null else bootstrap_key_version end,
    cleanup_finished_at = case when v_complete then clock_timestamp() else null end
    where id = p_order_id returning * into v_order;
  if v_complete then
    delete from public.infrastructure_capacity_inventory where user_id = p_user_id
      and connection_id = p_connection_id and provider_resource_id = v_order.provider_resource_id;
  end if;
  return to_jsonb(v_order);
end;
$$;

-- Explicitly forget an idle failed cleanup without pretending its resources
-- are gone. This must not decrypt/call the provider: a revoked token still
-- needs a local revocation path. The unresolved capacity claim remains held.
create or replace function public.abandon_hetzner_cleanup(
  p_user_id text, p_connection_id uuid, p_order_id uuid, p_idempotency_key uuid, p_fingerprint text
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype; v_disposition text;
begin
  if exists (select 1 from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and connection_id = p_connection_id
    and cleanup_idempotency_key = p_idempotency_key and cleanup_resource_fingerprint = p_fingerprint
    and status = 'cleanup_abandoned') then return true; end if;
  perform id from public.infrastructure_connections where id = p_connection_id
    and user_id = p_user_id and provider = 'hetzner-cloud' for update;
  if not found then return false; end if;
  select * into v_order from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and active_connection_id = p_connection_id
    and cleanup_idempotency_key = p_idempotency_key and cleanup_resource_fingerprint = p_fingerprint
    and status = 'cleaning' for update;
  if not found then return false; end if;
  if v_order.cleanup_lease_expires_at > clock_timestamp() then
    raise exception 'Provider cleanup is still leased' using errcode = '55006';
  end if;
  update public.infrastructure_capacity_orders set status = 'cleanup_abandoned',
    active_connection_id = null, detached_at = clock_timestamp(),
    encrypted_bootstrap_bundle = null, bootstrap_key_version = null,
    cleanup_lease_id = null, cleanup_lease_expires_at = null, cleanup_abandoned_at = clock_timestamp()
    where id = p_order_id;
  v_disposition := public.delete_infrastructure_connection(p_user_id,p_connection_id);
  if v_disposition <> 'deleted' then
    raise exception 'Connection cannot be safely forgotten' using errcode = '55006';
  end if;
  return true;
end;
$$;

revoke all on function public.guard_hetzner_cleanup_order() from public, anon, authenticated;
revoke all on function public.guard_hetzner_cleanup_connection() from public, anon, authenticated;
revoke all on function public.guard_hetzner_cleanup_secret() from public, anon, authenticated;
revoke all on function public.claim_hetzner_cleanup(text,uuid,bigint,uuid,uuid,uuid,text,text) from public, anon, authenticated;
revoke all on function public.verify_hetzner_cleanup_lease(text,uuid,bigint,uuid,uuid) from public, anon, authenticated;
revoke all on function public.record_hetzner_cleanup_observation(text,uuid,bigint,uuid,uuid,jsonb,text) from public, anon, authenticated;
grant execute on function public.guard_hetzner_cleanup_order() to service_role;
grant execute on function public.guard_hetzner_cleanup_connection() to service_role;
grant execute on function public.guard_hetzner_cleanup_secret() to service_role;
grant execute on function public.claim_hetzner_cleanup(text,uuid,bigint,uuid,uuid,uuid,text,text) to service_role;
grant execute on function public.verify_hetzner_cleanup_lease(text,uuid,bigint,uuid,uuid) to service_role;
grant execute on function public.record_hetzner_cleanup_observation(text,uuid,bigint,uuid,uuid,jsonb,text) to service_role;
revoke all on function public.guard_hetzner_deleted_inventory() from public, anon, authenticated;
revoke all on function public.abandon_hetzner_cleanup(text,uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.guard_hetzner_deleted_inventory() to service_role;
grant execute on function public.abandon_hetzner_cleanup(text,uuid,uuid,uuid,text) to service_role;
