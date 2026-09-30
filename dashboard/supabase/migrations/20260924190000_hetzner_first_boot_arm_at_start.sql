-- Open a Hetzner server's first-boot setup window at Start setup (INF-02).
--
-- Hivra creates a server powered off and only runs it when the owner presses
-- Start setup. Recipe 2026.08.27.1 bound the one-time enrollment capability to
-- 15 minutes from creation, so an owner who waited longer had a paid server
-- that could never enroll.
--
-- Recipe 2026.09.24.1 (every new server) keeps the capability unusable until
-- Hivra itself powers this exact server on for setup. The checkpoint that
-- records that power-on (power_dispatch) arms the challenge in the same
-- transaction: armed_at = the recorded power-on, armed_expires_at = 15 minutes
-- plus 2 minutes for Hetzner's boot. The receiver (consume) accepts a proof
-- only while armed_at <= now < armed_expires_at, and never while unarmed. A
-- challenge is armed at most once: a recorded power-on, or any earlier arming,
-- refuses another, so an attacker who booted a leaked disk cannot be given a
-- fresh window; the recovery is a rebuild.
--
-- expires_at keeps its meaning for both recipes as the 15-minute delivery
-- window between staging and the server request. For 2026.08.27.1 it is also
-- still the enrollment window: those servers keep exactly today's rules.
--
-- Downstream checks that an identity was pinned inside its window
-- (enrolled_at between issued_at and expires_at) now use one recipe-aware
-- helper, patched in place so every other part of those functions is kept.
-- Rerunning this file is a no-op.

-- 1. Both recipes are valid on the durable record.
alter table public.infrastructure_first_boot_enrollments
  drop constraint if exists infrastructure_first_boot_enrollments_recipe_version_check;
alter table public.infrastructure_first_boot_enrollments
  add constraint infrastructure_first_boot_enrollments_recipe_version_check
  check (recipe_version in ('2026.08.27.1', '2026.09.24.1'));

-- 2. Armed state. Nullable columns without a default: adding them rewrites
-- nothing and fires no update trigger on existing rows.
alter table public.infrastructure_first_boot_enrollments
  add column if not exists armed_at timestamptz,
  add column if not exists armed_expires_at timestamptz;
alter table public.infrastructure_first_boot_enrollments
  drop constraint if exists infrastructure_first_boot_armed_state;
alter table public.infrastructure_first_boot_enrollments
  add constraint infrastructure_first_boot_armed_state check ((
    (armed_at is null) = (armed_expires_at is null)
    and (armed_at is null or (recipe_version = '2026.09.24.1' and phase <> 'staged'
      and armed_at >= issued_at and armed_expires_at = armed_at + interval '17 minutes'))
    and (recipe_version <> '2026.09.24.1' or phase <> 'enrolled'
      or (armed_at is not null and enrolled_at >= armed_at and enrolled_at < armed_expires_at))
  ) is true);

-- 3. Recipe-aware window helpers. Unknown recipes are always closed.
-- When enrollment authority ends: legacy 15 minutes after creation; current
-- the armed expiry, or not before Start setup (it cannot enroll until then).
create or replace function public.hetzner_first_boot_deadline(
  p_recipe text, p_expires_at timestamptz, p_armed_expires_at timestamptz
)
returns timestamptz language sql immutable set search_path = public, pg_temp as $$
  select case p_recipe
    when '2026.08.27.1' then p_expires_at
    when '2026.09.24.1' then coalesce(p_armed_expires_at, 'infinity'::timestamptz)
    else '-infinity'::timestamptz end;
$$;

-- Whether Hivra accepts a proof, or accepted a pinned identity, at p_at.
create or replace function public.hetzner_first_boot_window_contains(
  p_recipe text, p_issued_at timestamptz, p_expires_at timestamptz,
  p_armed_at timestamptz, p_armed_expires_at timestamptz, p_at timestamptz
)
returns boolean language sql immutable set search_path = public, pg_temp as $$
  select coalesce(case p_recipe
    when '2026.08.27.1' then p_at >= p_issued_at and p_at < p_expires_at
    when '2026.09.24.1' then p_armed_at is not null and p_at >= p_armed_at and p_at < p_armed_expires_at
    else false end, false);
$$;

-- 4. The window opens once, only inside the setup power-on checkpoint (which
-- sets the transaction-local marker), only while awaiting identity, and only
-- before any power-on has been recorded for this attempt.
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
  if new.armed_at is distinct from old.armed_at or new.armed_expires_at is distinct from old.armed_expires_at then
    if old.armed_at is not null or old.armed_expires_at is not null or new.armed_at is null
      or old.recipe_version is distinct from '2026.09.24.1'
      or old.phase is distinct from 'awaiting_identity' or new.phase is distinct from 'awaiting_identity'
      or coalesce(current_setting('hivra.first_boot_power_dispatch', true), '') is distinct from old.order_id::text
      or exists (select 1 from public.infrastructure_first_boot_operations
        where order_id = old.order_id and power_on_post_attempted_at is not null) then
      raise exception 'The setup window opens once, only with Hivra''s recorded setup power-on' using errcode = '55006';
    end if;
    v_allowed := v_allowed || array['armed_at','armed_expires_at'];
  end if;
  if (to_jsonb(old) - v_allowed) is distinct from (to_jsonb(new) - v_allowed) then
    raise exception 'First-boot binding and pinned identity are immutable' using errcode = '55006';
  end if;
  return new;
end;
$$;

-- The reverse direction: a setup power-on recorded for a current-recipe
-- attempt must carry the arming made in the same step (armed_at equals the
-- recorded power-on). A direct write cannot record one without the other.
create or replace function public.guard_first_boot_power_on_arming()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
begin
  if new.power_on_post_attempted_at is not null
    and (tg_op = 'INSERT' or old.power_on_post_attempted_at is null) then
    select * into v_enrollment from public.infrastructure_first_boot_enrollments
      where order_id = new.order_id and attempt_id = new.attempt_id;
    if found and v_enrollment.recipe_version = '2026.09.24.1'
      and v_enrollment.armed_at is distinct from new.power_on_post_attempted_at then
      raise exception 'A setup power-on must open the setup window in the same step' using errcode = '55006';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists infrastructure_first_boot_operations_arming_guard on public.infrastructure_first_boot_operations;
create trigger infrastructure_first_boot_operations_arming_guard
  before insert or update on public.infrastructure_first_boot_operations
  for each row execute function public.guard_first_boot_power_on_arming();

-- And at commit: an armed challenge has the matching recorded power-on, so no
-- path (even one that sets the checkpoint's marker) arms without powering on.
create or replace function public.assert_first_boot_armed_with_power_on()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.armed_at is not null and not exists (select 1 from public.infrastructure_first_boot_operations
    where order_id = new.order_id and attempt_id = new.attempt_id and power_on_post_attempted_at = new.armed_at) then
    raise exception 'The setup window opens only in the transaction that records the setup power-on' using errcode = '55006';
  end if;
  return null;
end;
$$;
drop trigger if exists infrastructure_first_boot_enrollments_armed_power_on on public.infrastructure_first_boot_enrollments;
create constraint trigger infrastructure_first_boot_enrollments_armed_power_on
  after insert or update on public.infrastructure_first_boot_enrollments
  deferrable initially deferred
  for each row execute function public.assert_first_boot_armed_with_power_on();

-- 5. Staging accepts both recipes so a request from the previous deployment
-- (still rendering 2026.08.27.1) keeps working until it is replaced.
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
    or p_recipe_version is null or p_recipe_version not in ('2026.08.27.1', '2026.09.24.1')
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
      and v_record.recipe_version = p_recipe_version
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

-- 6. Receipt-bound eligibility (staged -> awaiting_identity), not arming and
-- not a power-on. A current-recipe server may reach it at any time after
-- creation; the legacy recipe keeps its 15 minutes from creation.
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
  if not found or public.hetzner_first_boot_deadline(v_record.recipe_version, v_record.expires_at,
      v_record.armed_expires_at) <= clock_timestamp() then return false; end if;
  if v_record.phase = 'awaiting_identity' then return v_record.provider_server_id = p_server_id; end if;
  if v_record.phase <> 'staged' then return false; end if;
  update public.infrastructure_first_boot_enrollments set phase = 'awaiting_identity',
    provider_server_id = p_server_id,updated_at = clock_timestamp() where order_id = p_order_id;
  return true;
end;
$$;

-- 7. Consumption: the database's own decision, after the receiver's proof and
-- fresh provider checks. A current-recipe proof is accepted only inside the
-- window Hivra opened; an unarmed challenge is always refused.
create or replace function public.consume_hetzner_first_boot(
  p_user_id text, p_connection_id uuid, p_revision bigint, p_order_id uuid, p_attempt_id uuid,
  p_server_id text, p_verifier text, p_host_key text, p_host_fingerprint text,
  p_provider_observed_at timestamptz
)
returns text language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_record public.infrastructure_first_boot_enrollments%rowtype;
  v_now timestamptz;
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
  -- One clock reading after the locks, for the window and the pinned time.
  v_now := clock_timestamp();
  if not found or public.hetzner_first_boot_window_contains(v_record.recipe_version, v_record.issued_at,
      v_record.expires_at, v_record.armed_at, v_record.armed_expires_at, v_now) is distinct from true
    or p_provider_observed_at < v_now - interval '30 seconds'
    or p_provider_observed_at > v_now + interval '5 seconds' then return 'rejected'; end if;
  if v_record.phase = 'enrolled' then
    if v_record.host_public_key = p_host_key and v_record.host_fingerprint_sha256 = p_host_fingerprint then
      return 'acknowledgement_replay';
    end if;
    return 'identity_changed';
  end if;
  if v_record.phase <> 'awaiting_identity' then return 'rejected'; end if;
  update public.infrastructure_first_boot_enrollments set phase = 'enrolled',encrypted_token = null,
    host_public_key = p_host_key,host_fingerprint_sha256 = p_host_fingerprint,
    provider_observed_at = p_provider_observed_at,enrolled_at = v_now,updated_at = v_now
    where order_id = p_order_id;
  return 'enrolled';
end;
$$;

-- 8. Setup leases end at the enrollment deadline: legacy from creation;
-- current not before Start setup, then at the armed expiry.
create or replace function public.claim_hetzner_first_boot_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,p_quote text,p_server text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_operation public.infrastructure_first_boot_operations%rowtype;
  v_deadline timestamptz;
begin
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_revision for update;
  if not found then return jsonb_build_object('outcome','rejected'); end if;
  select * into v_order from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_revision
    and quote_fingerprint_sha256=p_quote for update;
  if not found or v_order.status <> 'created_off' or v_order.provider_resource_id is distinct from p_server
    or v_order.provider_creation_receipt->>'serverId' is distinct from p_server
    or v_order.provider_ssh_key_id is null or v_order.provider_ssh_key_status <> 'accepted' then
    return jsonb_build_object('outcome','rejected'); end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments where order_id=p_order_id
    and attempt_id=p_attempt_id and capacity_idempotency_key=v_order.idempotency_key for update;
  if found then
    v_deadline := public.hetzner_first_boot_deadline(v_enrollment.recipe_version,v_enrollment.expires_at,
      v_enrollment.armed_expires_at);
  end if;
  if not found or v_enrollment.phase not in ('staged','awaiting_identity','enrolled')
    or v_deadline <= clock_timestamp()+interval '60 seconds'
    or (v_enrollment.provider_server_id is not null and v_enrollment.provider_server_id <> p_server) then
    return jsonb_build_object('outcome','rejected'); end if;
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=p_order_id for update;
  if found then
    if v_operation.abandoned_at is not null then return jsonb_build_object('outcome','rejected'); end if;
    if v_operation.lease_expires_at > clock_timestamp() then return jsonb_build_object('outcome','busy'); end if;
    update public.infrastructure_first_boot_operations set lease_id=gen_random_uuid(),
      lease_expires_at=least(clock_timestamp()+interval '120 seconds',v_deadline),updated_at=clock_timestamp()
      where order_id=p_order_id returning * into v_operation;
  else
    insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,
      connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at)
      values(p_order_id,p_attempt_id,p_user_id,p_connection_id,p_revision,p_quote,p_server,gen_random_uuid(),
        least(clock_timestamp()+interval '120 seconds',v_deadline)) returning * into v_operation;
  end if;
  return jsonb_build_object('outcome','claimed','record',to_jsonb(v_operation));
end;
$$;

-- 9. The setup power-on checkpoint arms a current-recipe challenge in the
-- same transaction that records the power-on (both at the same instant).
create or replace function public.checkpoint_hetzner_first_boot_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,
  p_quote text,p_server text,p_lease_id uuid,p_event text,p_evidence jsonb default null,p_observed_at timestamptz default null
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_operation public.infrastructure_first_boot_operations%rowtype;
  v_now timestamptz;
begin
  if p_event is null or p_event not in ('firewall_dispatch','firewall_receipt','firewall_verified','power_dispatch','power_receipt') then
    raise exception 'Invalid first-boot checkpoint' using errcode = '22023'; end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_revision for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_revision
    and status='created_off' for update;
  if not found then return false; end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments where order_id=p_order_id
    and attempt_id=p_attempt_id for update;
  if not found or v_enrollment.phase not in ('staged','awaiting_identity','enrolled')
    or public.hetzner_first_boot_deadline(v_enrollment.recipe_version,v_enrollment.expires_at,
      v_enrollment.armed_expires_at) <= clock_timestamp() then return false; end if;
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=p_order_id
    and attempt_id=p_attempt_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and quote_fingerprint_sha256=p_quote
    and provider_server_id=p_server and lease_id=p_lease_id for update;
  if not found or v_operation.abandoned_at is not null or v_operation.lease_expires_at <= clock_timestamp() then return false; end if;
  if p_event in ('firewall_dispatch','power_dispatch') and (p_evidence is not null or p_observed_at is not null
    or v_operation.lease_expires_at <= clock_timestamp()+interval '30 seconds') then return false; end if;
  case p_event
    when 'firewall_dispatch' then
      if v_operation.firewall_post_attempted_at is not null or v_enrollment.phase='enrolled' then return false; end if;
      update public.infrastructure_first_boot_operations set firewall_post_attempted_at=clock_timestamp() where order_id=p_order_id;
    when 'firewall_receipt' then
      if p_observed_at is not null or v_operation.firewall_post_attempted_at is null
        or public.is_valid_first_boot_firewall_receipt(p_evidence,p_order_id,p_attempt_id,
          v_operation.quote_fingerprint_sha256,v_operation.provider_server_id) is distinct from true then return false; end if;
      if v_operation.firewall_receipt is not null then return v_operation.firewall_receipt=p_evidence; end if;
      update public.infrastructure_first_boot_operations set firewall_receipt=p_evidence where order_id=p_order_id;
    when 'firewall_verified' then
      if p_evidence is distinct from v_operation.firewall_receipt or p_evidence is null
        or p_observed_at is null or p_observed_at < clock_timestamp()-interval '30 seconds'
        or p_observed_at > clock_timestamp()+interval '5 seconds'
        or p_observed_at < v_operation.firewall_post_attempted_at
        or p_observed_at < v_operation.firewall_verified_at or v_operation.power_on_post_attempted_at is not null then return false; end if;
      update public.infrastructure_first_boot_operations set firewall_verified_at=p_observed_at where order_id=p_order_id;
    when 'power_dispatch' then
      if v_operation.power_on_post_attempted_at is not null or v_operation.firewall_verified_at is null
        or v_operation.firewall_verified_at < clock_timestamp()-interval '30 seconds'
        or v_enrollment.phase <> 'awaiting_identity'
        or v_enrollment.provider_server_id is distinct from v_operation.provider_server_id then return false; end if;
      v_now := clock_timestamp();
      if v_enrollment.recipe_version = '2026.09.24.1' then
        -- Arm only while awaiting identity with no power-on ever recorded for
        -- this challenge (checked above), and never a second time.
        if v_enrollment.armed_at is not null or v_enrollment.armed_expires_at is not null then return false; end if;
        perform set_config('hivra.first_boot_power_dispatch', p_order_id::text, true);
        update public.infrastructure_first_boot_enrollments set armed_at=v_now,
          armed_expires_at=v_now+interval '17 minutes',updated_at=v_now where order_id=p_order_id;
        perform set_config('hivra.first_boot_power_dispatch', '', true);
      end if;
      update public.infrastructure_first_boot_operations set power_on_post_attempted_at=v_now where order_id=p_order_id;
    when 'power_receipt' then
      if p_observed_at is not null or v_operation.power_on_post_attempted_at is null
        or public.is_valid_first_boot_power_action(p_evidence,v_operation.provider_server_id) is distinct from true then return false; end if;
      if v_operation.power_on_action is not null and (
        v_operation.power_on_action-'status' is distinct from p_evidence-'status'
        or (v_operation.power_on_action->>'status' <> 'running' and v_operation.power_on_action is distinct from p_evidence)) then return false; end if;
      update public.infrastructure_first_boot_operations set power_on_action=p_evidence where order_id=p_order_id;
  end case;
  update public.infrastructure_first_boot_operations set updated_at=clock_timestamp() where order_id=p_order_id;
  return true;
end;
$$;

-- 10. An enrolled guest of either recipe: its identity was pinned inside the
-- window of the recipe it was created with.
create or replace function public.claim_hetzner_enrolled_guest_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,p_quote text,p_server text
)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_order public.infrastructure_capacity_orders%rowtype;
  v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_operation public.infrastructure_first_boot_operations%rowtype;
begin
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and status='ready' and revision=p_revision for update;
  if not found then return jsonb_build_object('outcome','rejected'); end if;
  select * into v_order from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and connection_id=p_connection_id and active_connection_id=p_connection_id and connection_revision=p_revision
    and quote_fingerprint_sha256=p_quote for update;
  if not found or v_order.status <> 'created_off' or v_order.provider_resource_id is distinct from p_server
    or v_order.provider_creation_receipt->>'serverId' is distinct from p_server
    or v_order.provider_server_status is distinct from 'accepted'
    or v_order.provider_ssh_key_id is null or v_order.provider_ssh_key_status is distinct from 'accepted'
    or v_order.encrypted_bootstrap_bundle is null or v_order.bootstrap_key_version is distinct from 2 then
    return jsonb_build_object('outcome','rejected'); end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments where order_id=p_order_id
    and attempt_id=p_attempt_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and quote_fingerprint_sha256=p_quote
    and capacity_idempotency_key=v_order.idempotency_key for update;
  if not found or v_enrollment.phase <> 'enrolled' or v_enrollment.recipe_version not in ('2026.08.27.1','2026.09.24.1')
    or v_enrollment.provider_server_id is distinct from p_server or v_enrollment.encrypted_token is not null
    or v_enrollment.enrolled_at is null
    or public.hetzner_first_boot_window_contains(v_enrollment.recipe_version,v_enrollment.issued_at,
      v_enrollment.expires_at,v_enrollment.armed_at,v_enrollment.armed_expires_at,v_enrollment.enrolled_at) is distinct from true
    or public.is_valid_first_boot_host_key(v_enrollment.host_public_key,v_enrollment.host_fingerprint_sha256)
      is distinct from true then return jsonb_build_object('outcome','rejected'); end if;
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=p_order_id
    and attempt_id=p_attempt_id and user_id=p_user_id and connection_id=p_connection_id
    and connection_revision=p_revision and quote_fingerprint_sha256=p_quote and provider_server_id=p_server for update;
  if not found or v_operation.abandoned_at is not null or v_operation.firewall_receipt is null
    or v_operation.firewall_verified_at is null or v_operation.power_on_post_attempted_at is null
    or v_operation.power_on_action is null or v_operation.power_on_action->>'status' = 'error' then
    return jsonb_build_object('outcome','rejected'); end if;
  if v_operation.lease_expires_at > clock_timestamp() then return jsonb_build_object('outcome','busy'); end if;
  -- Fresh bounded authority, not an extension of the bootstrap capability.
  -- The worker must anchor its shorter monotonic dispatch budget before claim.
  update public.infrastructure_first_boot_operations set lease_id=gen_random_uuid(),
    lease_expires_at=clock_timestamp()+interval '120 seconds',updated_at=clock_timestamp()
    where order_id=p_order_id returning * into v_operation;
  return jsonb_build_object('outcome','claimed','record',to_jsonb(v_operation));
end;
$$;

-- 11. The same window check inside the long provider-computer functions,
-- patched in place (like the provider release admissions) so a later edit of
-- any other part of them is kept. An absent function has nothing to patch; a
-- definition that has neither the original anchor nor the patch fails closed.
do $migration$
declare v_signature text; v_anchor text; v_patch text; v_definition text;
begin
  for v_signature, v_anchor, v_patch in select * from (values
    ('public.admit_prepared_provider_computer(text,uuid,bigint,uuid,uuid,text,uuid,uuid,jsonb)',
     'and enrolled_at>=issued_at and enrolled_at<expires_at',
     'and public.hetzner_first_boot_window_contains(recipe_version,issued_at,expires_at,armed_at,armed_expires_at,enrolled_at)'),
    ('public.guard_hivra_provider_agent()',
     'or v_enrollment.enrolled_at<v_enrollment.issued_at or v_enrollment.enrolled_at>=v_enrollment.expires_at',
     'or public.hetzner_first_boot_window_contains(v_enrollment.recipe_version,v_enrollment.issued_at,v_enrollment.expires_at,v_enrollment.armed_at,v_enrollment.armed_expires_at,v_enrollment.enrolled_at) is distinct from true'),
    ('public.hivra_workspace_binding_current(public.hivra_workspace_sessions)',
     'and e.enrolled_at>=e.issued_at and e.enrolled_at<e.expires_at',
     'and public.hetzner_first_boot_window_contains(e.recipe_version,e.issued_at,e.expires_at,e.armed_at,e.armed_expires_at,e.enrolled_at)')
  ) as patches(signature, anchor, patch)
  loop
    if to_regprocedure(v_signature) is null then continue; end if;
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    if position(v_anchor in v_definition) = 0 and position(v_patch in v_definition) > 0 then continue; end if;
    if (length(v_definition) - length(replace(v_definition, v_anchor, ''))) / length(v_anchor) <> 1 then
      raise exception 'First-boot window patch anchor mismatch: %', v_signature;
    end if;
    execute replace(v_definition, v_anchor, v_patch);
  end loop;
end;
$migration$;

-- Service role only, including the helpers the triggers and RPCs call.
revoke all on function public.hetzner_first_boot_deadline(text,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.hetzner_first_boot_window_contains(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) from public,anon,authenticated;
revoke all on function public.guard_first_boot_enrollment() from public,anon,authenticated;
revoke all on function public.guard_first_boot_power_on_arming() from public,anon,authenticated;
revoke all on function public.assert_first_boot_armed_with_power_on() from public,anon,authenticated;
revoke all on function public.stage_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,text) from public,anon,authenticated;
revoke all on function public.arm_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,jsonb) from public,anon,authenticated;
revoke all on function public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz) from public,anon,authenticated;
revoke all on function public.claim_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.hetzner_first_boot_deadline(text,timestamptz,timestamptz) to service_role;
grant execute on function public.hetzner_first_boot_window_contains(text,timestamptz,timestamptz,timestamptz,timestamptz,timestamptz) to service_role;
grant execute on function public.stage_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,text,timestamptz,timestamptz,text,text,text) to service_role;
grant execute on function public.arm_hetzner_first_boot(text,uuid,bigint,uuid,uuid,uuid,text,jsonb) to service_role;
grant execute on function public.consume_hetzner_first_boot(text,uuid,bigint,uuid,uuid,text,text,text,text,timestamptz) to service_role;
grant execute on function public.claim_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text) to service_role;
grant execute on function public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz) to service_role;
grant execute on function public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text) to service_role;
