-- Private first-boot identity extension of the existing capacity order.
-- This ledger grants neither power-on nor deployment-target readiness.
-- Application activation still requires fresh provider checks and pinned SSH.
alter table public.infrastructure_capacity_orders
  add constraint infrastructure_capacity_orders_first_boot_binding_unique
  unique (id, user_id, connection_id, connection_revision, quote_fingerprint_sha256);

create or replace function public.is_valid_first_boot_host_key(p_key text, p_fingerprint text)
returns boolean language plpgsql immutable strict set search_path = public, pg_temp as $$
declare v_blob bytea;
begin
  if p_key !~ '^ssh-ed25519 [A-Za-z0-9+/]{68}$'
    or p_fingerprint !~ '^SHA256:[A-Za-z0-9+/]{43}$' then return false; end if;
  v_blob := decode(split_part(p_key, ' ', 2), 'base64');
  return octet_length(v_blob) = 51
    and encode(v_blob, 'base64') = split_part(p_key, ' ', 2)
    and substring(v_blob from 1 for 19) = decode('0000000b7373682d6564323535313900000020', 'hex')
    and substring(v_blob from 20 for 32) <> decode(repeat('00', 32), 'hex')
    and p_fingerprint = 'SHA256:' || rtrim(encode(sha256(v_blob), 'base64'), '=');
exception when others then return false;
end;
$$;

create table public.infrastructure_first_boot_enrollments (
  order_id uuid primary key,
  user_id text not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  quote_fingerprint_sha256 text not null,
  attempt_id uuid not null unique,
  capacity_idempotency_key uuid not null,
  recipe_version text not null check (recipe_version = '2026.08.27.1'),
  phase text not null check (phase in ('staged', 'awaiting_identity', 'enrolled', 'revoked', 'failed')),
  issued_at timestamptz not null,
  expires_at timestamptz not null check (expires_at = issued_at + interval '15 minutes'),
  verifier_sha256 text not null check (verifier_sha256 ~ '^[0-9a-f]{64}$'),
  encrypted_token text,
  preparation_confirmed_at timestamptz not null default clock_timestamp(),
  provider_server_id text check (provider_server_id ~ '^[1-9][0-9]{0,15}$'
    and provider_server_id::numeric <= 9007199254740991),
  host_public_key text,
  host_fingerprint_sha256 text,
  provider_observed_at timestamptz,
  enrolled_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (order_id, user_id, connection_id, connection_revision, quote_fingerprint_sha256)
    references public.infrastructure_capacity_orders
      (id, user_id, connection_id, connection_revision, quote_fingerprint_sha256) on delete restrict,
  constraint infrastructure_first_boot_secret_state check (
    ((phase in ('staged','awaiting_identity') and encrypted_token is not null
        and octet_length(encrypted_token) between 32 and 16384)
      or (phase in ('enrolled','revoked','failed') and encrypted_token is null)) is true
  ),
  constraint infrastructure_first_boot_phase_state check (
    ((phase = 'staged' and provider_server_id is null and host_public_key is null
        and host_fingerprint_sha256 is null and enrolled_at is null and provider_observed_at is null)
      or (phase = 'awaiting_identity' and provider_server_id is not null and host_public_key is null
        and host_fingerprint_sha256 is null and enrolled_at is null and provider_observed_at is null)
      or (phase = 'enrolled' and provider_server_id is not null and host_public_key is not null
        and host_fingerprint_sha256 is not null and enrolled_at is not null and provider_observed_at is not null)
      or (phase in ('revoked','failed') and (
        (host_public_key is null and host_fingerprint_sha256 is null and enrolled_at is null and provider_observed_at is null)
        or (provider_server_id is not null and host_public_key is not null
          and host_fingerprint_sha256 is not null and enrolled_at is not null and provider_observed_at is not null)))) is true
  ),
  constraint infrastructure_first_boot_key_binding check (
    host_public_key is null
    or public.is_valid_first_boot_host_key(host_public_key, host_fingerprint_sha256) is true
  )
);
alter table public.infrastructure_first_boot_enrollments enable row level security;
revoke all on public.infrastructure_first_boot_enrollments from public, anon, authenticated;
grant select, insert, update on public.infrastructure_first_boot_enrollments to service_role;

create or replace function public.guard_first_boot_enrollment()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_allowed text[] := array['updated_at','phase','encrypted_token'];
begin
  if tg_op = 'DELETE' then
    raise exception 'First-boot identity evidence cannot be deleted' using errcode = '55006';
  end if;
  if old.phase in ('revoked','failed') and new.phase is distinct from old.phase then
    raise exception 'First-boot authority is terminal' using errcode = '55006';
  end if;
  if new.phase is distinct from old.phase and not (
    (old.phase = 'staged' and new.phase in ('awaiting_identity','revoked','failed'))
    or (old.phase = 'awaiting_identity' and new.phase in ('enrolled','revoked','failed'))
    or (old.phase = 'enrolled' and new.phase = 'revoked')
  ) then raise exception 'Invalid first-boot transition' using errcode = '55006'; end if;
  if new.encrypted_token is distinct from old.encrypted_token
    and not (new.encrypted_token is null and new.phase in ('enrolled','revoked','failed')) then
    raise exception 'First-boot secret cannot be replaced' using errcode = '55006';
  end if;
  if old.phase = 'staged' and new.phase = 'awaiting_identity' then
    v_allowed := v_allowed || array['provider_server_id'];
  end if;
  if old.phase = 'awaiting_identity' and new.phase = 'enrolled' then
    v_allowed := v_allowed || array['host_public_key','host_fingerprint_sha256','provider_observed_at','enrolled_at'];
  end if;
  if (to_jsonb(old) - v_allowed) is distinct from (to_jsonb(new) - v_allowed) then
    raise exception 'First-boot binding and pinned identity are immutable' using errcode = '55006';
  end if;
  return new;
end;
$$;
create trigger infrastructure_first_boot_enrollment_guard
  before update or delete on public.infrastructure_first_boot_enrollments
  for each row execute function public.guard_first_boot_enrollment();

-- Capture preparation consent before the provider server POST. Billing
-- confirmation alone cannot stage a capability. A replay returns the original
-- private record; it does not rotate or extend the token.
create or replace function public.stage_hetzner_first_boot(
  p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid,
  p_capacity_key uuid, p_attempt_id uuid, p_quote_fingerprint text,
  p_recipe_version text, p_issued_at timestamptz, p_expires_at timestamptz,
  p_verifier text, p_encrypted_token text, p_confirmation text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_record public.infrastructure_first_boot_enrollments%rowtype;
begin
  if p_confirmation is distinct from 'Prepare this computer for agent launch'
    or p_attempt_id is null or p_capacity_key is null
    or p_recipe_version is distinct from '2026.08.27.1'
    or p_issued_at is null or p_expires_at is null
    or p_expires_at <> p_issued_at + interval '15 minutes'
    or p_issued_at > clock_timestamp() + interval '5 seconds'
    or p_verifier is null or p_verifier !~ '^[0-9a-f]{64}$'
    or p_encrypted_token is null or octet_length(p_encrypted_token) not between 32 and 16384 then
    raise exception 'Invalid first-boot intent' using errcode = '22023';
  end if;
  perform id from public.infrastructure_connections where id = p_connection_id
    and user_id = p_user_id and provider = 'hetzner-cloud' and status = 'ready'
    and revision = p_revision for update;
  if not found then return jsonb_build_object('outcome','rejected'); end if;
  select * into v_order from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and connection_id = p_connection_id and active_connection_id = p_connection_id
    and connection_revision = p_revision and idempotency_key = p_capacity_key
    and quote_fingerprint_sha256 = p_quote_fingerprint for update;
  if not found then return jsonb_build_object('outcome','rejected'); end if;
  select * into v_record from public.infrastructure_first_boot_enrollments where order_id = p_order_id for update;
  if found then
    if v_record.attempt_id = p_attempt_id and v_record.verifier_sha256 = p_verifier
      and v_record.issued_at = p_issued_at and v_record.expires_at = p_expires_at
      and v_record.phase = 'staged' and v_record.expires_at > clock_timestamp()
      and v_order.status = 'creating' and v_order.server_post_attempted_at is null then
      return jsonb_build_object('outcome','staged','record',to_jsonb(v_record));
    end if;
    return jsonb_build_object('outcome','rejected');
  end if;
  if v_order.status <> 'creating' or v_order.server_post_attempted_at is not null
    or p_issued_at < clock_timestamp() - interval '60 seconds' then
    return jsonb_build_object('outcome','rejected');
  end if;
  insert into public.infrastructure_first_boot_enrollments (
    order_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256,attempt_id,
    capacity_idempotency_key,recipe_version,phase,issued_at,expires_at,verifier_sha256,encrypted_token
  ) values (p_order_id,p_user_id,p_connection_id,p_revision,p_quote_fingerprint,p_attempt_id,
    p_capacity_key,p_recipe_version,'staged',p_issued_at,p_expires_at,p_verifier,p_encrypted_token)
    returning * into v_record;
  return jsonb_build_object('outcome','staged','record',to_jsonb(v_record));
end;
$$;

-- Arm receipt-bound enrollment only. This RPC neither powers on a server nor
-- certifies the first-boot firewall. The preparation coordinator must separately
-- verify and own those operations before it dispatches power-on.
create or replace function public.arm_hetzner_first_boot(
  p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid,
  p_attempt_id uuid, p_capacity_key uuid, p_server_id text, p_creation_receipt jsonb
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_record public.infrastructure_first_boot_enrollments%rowtype;
begin
  perform id from public.infrastructure_connections where id = p_connection_id and user_id = p_user_id
    and provider = 'hetzner-cloud' and status = 'ready' and revision = p_revision for update;
  if not found then return false; end if;
  select * into v_order from public.infrastructure_capacity_orders where id = p_order_id
    and user_id = p_user_id and connection_id = p_connection_id and active_connection_id = p_connection_id
    and connection_revision = p_revision and idempotency_key = p_capacity_key for update;
  if not found or v_order.status <> 'created_off'
    or v_order.provider_creation_receipt is null
    or v_order.provider_creation_receipt is distinct from p_creation_receipt
    or v_order.provider_resource_id is distinct from p_server_id
    or v_order.provider_creation_receipt->>'serverId' is distinct from p_server_id then return false; end if;
  select * into v_record from public.infrastructure_first_boot_enrollments where order_id = p_order_id
    and attempt_id = p_attempt_id for update;
  if not found or v_record.expires_at <= clock_timestamp() then return false; end if;
  if v_record.phase = 'awaiting_identity' then return v_record.provider_server_id = p_server_id; end if;
  if v_record.phase <> 'staged' then return false; end if;
  update public.infrastructure_first_boot_enrollments set phase = 'awaiting_identity',
    provider_server_id = p_server_id,updated_at = clock_timestamp() where order_id = p_order_id;
  return true;
end;
$$;

-- Called only after application-side proof verification and fresh exact-
-- resource provider checks. Serialize the final decision with revocation,
-- cleanup and competing enrollments; one key wins, never last-writer-wins.
create or replace function public.consume_hetzner_first_boot(
  p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid,
  p_server_id text, p_verifier text, p_host_key text, p_host_fingerprint text,
  p_provider_observed_at timestamptz
)
returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_record public.infrastructure_first_boot_enrollments%rowtype;
begin
  if public.is_valid_first_boot_host_key(p_host_key,p_host_fingerprint) is distinct from true
    or p_provider_observed_at is null then return 'rejected'; end if;
  perform id from public.infrastructure_connections where id = p_connection_id and user_id = p_user_id
    and provider = 'hetzner-cloud' and status = 'ready' and revision = p_revision for update;
  if not found then return 'rejected'; end if;
  perform id from public.infrastructure_capacity_orders where id = p_order_id and user_id = p_user_id
    and connection_id = p_connection_id and active_connection_id = p_connection_id
    and connection_revision = p_revision and status = 'created_off'
    and provider_resource_id = p_server_id and provider_creation_receipt->>'serverId' = p_server_id for update;
  if not found then return 'rejected'; end if;
  select * into v_record from public.infrastructure_first_boot_enrollments where order_id = p_order_id
    and user_id = p_user_id and connection_id = p_connection_id and connection_revision = p_revision
    and attempt_id = p_attempt_id and provider_server_id = p_server_id and verifier_sha256 = p_verifier for update;
  if not found or v_record.issued_at > clock_timestamp() or v_record.expires_at <= clock_timestamp()
    or p_provider_observed_at < clock_timestamp() - interval '30 seconds'
    or p_provider_observed_at > clock_timestamp() + interval '5 seconds' then return 'rejected'; end if;
  if v_record.phase = 'enrolled' then
    if v_record.host_public_key = p_host_key and v_record.host_fingerprint_sha256 = p_host_fingerprint then
      return 'acknowledgement_replay';
    end if;
    return 'identity_changed';
  end if;
  if v_record.phase <> 'awaiting_identity' then return 'rejected'; end if;
  update public.infrastructure_first_boot_enrollments set phase = 'enrolled',encrypted_token = null,
    host_public_key = p_host_key,host_fingerprint_sha256 = p_host_fingerprint,
    provider_observed_at = p_provider_observed_at,enrolled_at = clock_timestamp(),updated_at = clock_timestamp()
    where order_id = p_order_id;
  return 'enrolled';
end;
$$;

create or replace function public.revoke_first_boot_on_connection_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' or new.user_id is distinct from old.user_id or new.provider is distinct from old.provider
    or new.revision is distinct from old.revision then
    update public.infrastructure_first_boot_enrollments set phase = 'revoked',encrypted_token = null,
      updated_at = clock_timestamp() where connection_id = old.id and phase not in ('revoked','failed');
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connections_first_boot_revocation
  before update or delete on public.infrastructure_connections
  for each row execute function public.revoke_first_boot_on_connection_change();

create or replace function public.revoke_first_boot_on_secret_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform id from public.infrastructure_connections where id = old.connection_id for update;
  update public.infrastructure_first_boot_enrollments set phase = 'revoked',encrypted_token = null,
    updated_at = clock_timestamp() where connection_id = old.connection_id and phase not in ('revoked','failed');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_secrets_first_boot_revocation
  before update or delete on public.infrastructure_connection_secrets
  for each row execute function public.revoke_first_boot_on_secret_change();

create or replace function public.revoke_first_boot_on_order_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status not in ('creating','created_off') or new.active_connection_id is null
    or new.encrypted_bootstrap_bundle is null then
    update public.infrastructure_first_boot_enrollments set phase = 'revoked',encrypted_token = null,
      updated_at = clock_timestamp() where order_id = old.id and phase not in ('revoked','failed');
  end if;
  return new;
end;
$$;
create trigger infrastructure_orders_first_boot_revocation
  after update on public.infrastructure_capacity_orders
  for each row execute function public.revoke_first_boot_on_order_change();

revoke all on function public.is_valid_first_boot_host_key(text,text) from public,anon,authenticated;
revoke all on function public.guard_first_boot_enrollment() from public,anon,authenticated;
revoke all on function public.stage_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,text) from public,anon,authenticated;
revoke all on function public.arm_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.revoke_first_boot_on_connection_change() from public,anon,authenticated;
revoke all on function public.revoke_first_boot_on_secret_change() from public,anon,authenticated;
revoke all on function public.revoke_first_boot_on_order_change() from public,anon,authenticated;
grant execute on function public.is_valid_first_boot_host_key(text,text) to service_role;
grant execute on function public.stage_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,text) to service_role;
grant execute on function public.arm_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz) to service_role;

-- Preserve revoked enrollment audit rows when an early provider rejection
-- left no billable resource. Existing disconnect/force-forget prune paths must
-- detach those orders, not delete the parent under the retained identity FK.
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
      and not exists (select 1 from public.infrastructure_first_boot_enrollments enrollment
        where enrollment.order_id = infrastructure_capacity_orders.id)
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
    and not exists (select 1 from public.infrastructure_first_boot_enrollments enrollment
      where enrollment.order_id = infrastructure_capacity_orders.id)
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
    and status in ('ambiguous','provider_rejected');

  delete from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id;
  return 'forgotten';
end;
$$;
