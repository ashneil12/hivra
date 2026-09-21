-- Private mutation ownership for the existing capacity order, not readiness.
-- Nothing invokes this from the public create flow yet. Four-resource cleanup
-- must remain blocked once a fifth resource (the firewall) might exist.
alter table public.infrastructure_first_boot_enrollments
  add constraint infrastructure_first_boot_operation_binding_unique
  unique (order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256);

create or replace function public.is_valid_first_boot_firewall_receipt(
  p_receipt jsonb,p_order uuid,p_attempt uuid,p_quote text,p_server text
)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
declare v_scope jsonb;
begin
  v_scope := jsonb_build_object('orderId',p_order,'attemptId',p_attempt,
    'quoteFingerprint',p_quote,'serverId',p_server::bigint);
  return (jsonb_typeof(p_receipt) = 'object' and octet_length(p_receipt::text) <= 2048
    and p_receipt ?& array['version','scope','firewallId','createdAt','setRulesActionId','applyActionId']
    and p_receipt - array['version','scope','firewallId','createdAt','setRulesActionId','applyActionId'] = '{}'::jsonb
    and p_receipt->'version' = '1'::jsonb and p_receipt->'scope' = v_scope
    and jsonb_typeof(p_receipt->'createdAt') = 'string'
    and p_receipt->>'createdAt' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$'
    and isfinite((p_receipt->>'createdAt')::timestamptz)
    and jsonb_typeof(p_receipt->'firewallId') = 'number'
    and p_receipt->>'firewallId' ~ '^[1-9][0-9]{0,15}$'
    and (p_receipt->>'firewallId')::numeric <= 9007199254740991
    and jsonb_typeof(p_receipt->'setRulesActionId') = 'number'
    and p_receipt->>'setRulesActionId' ~ '^[1-9][0-9]{0,15}$'
    and (p_receipt->>'setRulesActionId')::numeric <= 9007199254740991
    and jsonb_typeof(p_receipt->'applyActionId') = 'number'
    and p_receipt->>'applyActionId' ~ '^[1-9][0-9]{0,15}$'
    and (p_receipt->>'applyActionId')::numeric <= 9007199254740991
    and p_receipt->'setRulesActionId' <> p_receipt->'applyActionId') is true;
exception when others then return false;
end;
$$;

create or replace function public.is_valid_first_boot_power_action(p_action jsonb,p_server text)
returns boolean language plpgsql immutable set search_path = public, pg_temp as $$
begin
  return (jsonb_typeof(p_action) = 'object' and octet_length(p_action::text) <= 1024
    and p_action ?& array['id','command','status','resources']
    and p_action - array['id','command','status','resources'] = '{}'::jsonb
    and jsonb_typeof(p_action->'id') = 'number' and p_action->>'id' ~ '^[1-9][0-9]{0,15}$'
    and (p_action->>'id')::numeric <= 9007199254740991
    and p_action->>'command' = 'start_server' and p_action->>'status' in ('running','success','error')
    and p_action->'resources' = jsonb_build_array(jsonb_build_object('id',p_server::bigint,'type','server'))) is true;
exception when others then return false;
end;
$$;

create table public.infrastructure_first_boot_operations (
  order_id uuid primary key,
  attempt_id uuid not null,
  user_id text not null,
  connection_id uuid not null,
  connection_revision bigint not null,
  quote_fingerprint_sha256 text not null,
  provider_server_id text not null check (provider_server_id ~ '^[1-9][0-9]{0,15}$'
    and provider_server_id::numeric <= 9007199254740991),
  lease_id uuid,
  lease_expires_at timestamptz,
  firewall_post_attempted_at timestamptz,
  firewall_receipt jsonb,
  firewall_verified_at timestamptz,
  power_on_post_attempted_at timestamptz,
  power_on_action jsonb,
  abandoned_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  foreign key (order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256)
    references public.infrastructure_first_boot_enrollments
      (order_id,attempt_id,user_id,connection_id,connection_revision,quote_fingerprint_sha256) on delete restrict,
  constraint infrastructure_first_boot_operation_state check (
    ((lease_id is null) = (lease_expires_at is null)
      and (abandoned_at is null or lease_id is null)
      and (firewall_receipt is null or (firewall_post_attempted_at is not null
        and public.is_valid_first_boot_firewall_receipt(firewall_receipt,order_id,attempt_id,quote_fingerprint_sha256,provider_server_id)))
      and (firewall_verified_at is null or firewall_receipt is not null)
      and (power_on_post_attempted_at is null or firewall_verified_at is not null)
      and (power_on_action is null or (power_on_post_attempted_at is not null
        and public.is_valid_first_boot_power_action(power_on_action,provider_server_id)))) is true
  )
);
alter table public.infrastructure_first_boot_operations enable row level security;
revoke all on public.infrastructure_first_boot_operations from public,anon,authenticated;
grant select,insert,update on public.infrastructure_first_boot_operations to service_role;

create or replace function public.guard_first_boot_operation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_mutable text[] := array['lease_id','lease_expires_at','firewall_post_attempted_at',
  'firewall_receipt','firewall_verified_at','power_on_post_attempted_at','power_on_action','abandoned_at','updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'First-boot mutation evidence cannot be deleted' using errcode = '55006';
  end if;
  if (to_jsonb(old) - v_mutable) is distinct from (to_jsonb(new) - v_mutable)
    or (old.abandoned_at is not null and to_jsonb(old)-'updated_at' is distinct from to_jsonb(new)-'updated_at')
    or (old.firewall_post_attempted_at is not null and new.firewall_post_attempted_at is distinct from old.firewall_post_attempted_at)
    or (old.firewall_receipt is not null and new.firewall_receipt is distinct from old.firewall_receipt)
    or (old.power_on_post_attempted_at is not null and new.power_on_post_attempted_at is distinct from old.power_on_post_attempted_at)
    or (old.firewall_verified_at is not null and (new.firewall_verified_at is null or new.firewall_verified_at < old.firewall_verified_at))
    or (old.power_on_action is not null and (new.power_on_action is null
      or old.power_on_action-'status' is distinct from new.power_on_action-'status'
      or (old.power_on_action->>'status' <> 'running' and new.power_on_action is distinct from old.power_on_action))) then
    raise exception 'First-boot mutation binding is immutable' using errcode = '55006';
  end if;
  if old.lease_id is not null and new.lease_id = old.lease_id
    and new.lease_expires_at is distinct from old.lease_expires_at then
    raise exception 'First-boot lease cannot be extended' using errcode = '55006';
  end if;
  if old.lease_expires_at > clock_timestamp() and
    ((new.lease_id is not null and new.lease_id is distinct from old.lease_id) or new.abandoned_at is not null) then
    raise exception 'First-boot operation is still leased' using errcode = '55006';
  end if;
  if (to_jsonb(old) - array['lease_id','lease_expires_at','abandoned_at','updated_at'])
    is distinct from (to_jsonb(new) - array['lease_id','lease_expires_at','abandoned_at','updated_at'])
    and (old.lease_id is null or old.lease_expires_at <= clock_timestamp() or old.abandoned_at is not null) then
    raise exception 'First-boot checkpoint requires a live lease' using errcode = '55006';
  end if;
  return new;
end;
$$;
create trigger infrastructure_first_boot_operations_guard
  before update or delete on public.infrastructure_first_boot_operations
  for each row execute function public.guard_first_boot_operation();

-- Every coordinator takes these same locks in connection -> order -> identity
-- -> operation order. Database-generated UUIDs prevent a stale worker from
-- selecting a previous lease ID again. An active claim is never renewed.
create or replace function public.claim_hetzner_first_boot_operation(
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
    or v_order.provider_ssh_key_id is null or v_order.provider_ssh_key_status <> 'accepted' then
    return jsonb_build_object('outcome','rejected'); end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments where order_id=p_order_id
    and attempt_id=p_attempt_id and capacity_idempotency_key=v_order.idempotency_key for update;
  if not found or v_enrollment.phase not in ('staged','awaiting_identity','enrolled')
    or v_enrollment.expires_at <= clock_timestamp()+interval '60 seconds'
    or (v_enrollment.provider_server_id is not null and v_enrollment.provider_server_id <> p_server) then
    return jsonb_build_object('outcome','rejected'); end if;
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=p_order_id for update;
  if found then
    if v_operation.abandoned_at is not null then return jsonb_build_object('outcome','rejected'); end if;
    if v_operation.lease_expires_at > clock_timestamp() then return jsonb_build_object('outcome','busy'); end if;
    update public.infrastructure_first_boot_operations set lease_id=gen_random_uuid(),
      lease_expires_at=least(clock_timestamp()+interval '120 seconds',v_enrollment.expires_at),updated_at=clock_timestamp()
      where order_id=p_order_id returning * into v_operation;
  else
    insert into public.infrastructure_first_boot_operations(order_id,attempt_id,user_id,connection_id,
      connection_revision,quote_fingerprint_sha256,provider_server_id,lease_id,lease_expires_at)
      values(p_order_id,p_attempt_id,p_user_id,p_connection_id,p_revision,p_quote,p_server,gen_random_uuid(),
        least(clock_timestamp()+interval '120 seconds',v_enrollment.expires_at)) returning * into v_operation;
  end if;
  return jsonb_build_object('outcome','claimed','record',to_jsonb(v_operation));
end;
$$;

-- Only trusted server code calls this closed checkpoint vocabulary. A stored
-- observation is not independent provider attestation. The caller must verify
-- exact original identities/firewall actions, then enforce its synchronous
-- local dispatch deadline after the final await and before a provider POST.
create or replace function public.checkpoint_hetzner_first_boot_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,
  p_quote text,p_server text,p_lease_id uuid,p_event text,p_evidence jsonb default null,p_observed_at timestamptz default null
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_operation public.infrastructure_first_boot_operations%rowtype;
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
    or v_enrollment.expires_at <= clock_timestamp() then return false; end if;
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
      update public.infrastructure_first_boot_operations set power_on_post_attempted_at=clock_timestamp() where order_id=p_order_id;
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

-- Release only the matching lease; never clear mutation intent or evidence.
-- Revoked/expired workers may release their own lease but cannot act afterward.
create or replace function public.release_hetzner_first_boot_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,p_quote text,p_server text,p_lease_id uuid
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=p_connection_id for update;
  perform id from public.infrastructure_capacity_orders where id=p_order_id for update;
  perform order_id from public.infrastructure_first_boot_enrollments where order_id=p_order_id for update;
  update public.infrastructure_first_boot_operations set lease_id=null,lease_expires_at=null,updated_at=clock_timestamp()
    where order_id=p_order_id and user_id=p_user_id and connection_id=p_connection_id
      and connection_revision=p_revision and attempt_id=p_attempt_id and quote_fingerprint_sha256=p_quote
      and provider_server_id=p_server and lease_id=p_lease_id;
  return found;
end;
$$;

-- Explicit setup abandonment, not access removal, provider deletion or
-- account-slot release. Retain provider/admin credentials for inspection; the
-- separately confirmed existing disconnect can subsequently remove them.
create or replace function public.abandon_hetzner_first_boot_operation(
  p_user_id text,p_connection_id uuid,p_revision bigint,p_order_id uuid,p_attempt_id uuid,
  p_quote text,p_server text,p_server_name text,p_confirmation text
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare v_operation public.infrastructure_first_boot_operations%rowtype;
begin
  if p_confirmation is distinct from 'Stop setup; provider resources and billing remain' then return false; end if;
  perform id from public.infrastructure_connections where id=p_connection_id and user_id=p_user_id
    and provider='hetzner-cloud' and revision=p_revision for update;
  if not found then return false; end if;
  perform id from public.infrastructure_capacity_orders where id=p_order_id and user_id=p_user_id
    and active_connection_id=p_connection_id and connection_revision=p_revision and server_name=p_server_name
    and quote_fingerprint_sha256=p_quote and provider_resource_id=p_server and status='created_off' for update;
  if not found then return false; end if;
  perform order_id from public.infrastructure_first_boot_enrollments where order_id=p_order_id and attempt_id=p_attempt_id for update;
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=p_order_id and attempt_id=p_attempt_id for update;
  if not found or v_operation.lease_expires_at > clock_timestamp() then return false; end if;
  if v_operation.abandoned_at is not null then return true; end if;
  update public.infrastructure_first_boot_operations set abandoned_at=clock_timestamp(),lease_id=null,
    lease_expires_at=null,updated_at=clock_timestamp() where order_id=p_order_id;
  update public.infrastructure_first_boot_enrollments set phase='revoked',encrypted_token=null,updated_at=clock_timestamp()
    where order_id=p_order_id and phase not in ('revoked','failed');
  return true;
end;
$$;

create or replace function public.guard_first_boot_operation_connection()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.infrastructure_first_boot_operations where connection_id=old.id
    and abandoned_at is null and (lease_expires_at>clock_timestamp() or firewall_post_attempted_at is not null)) then
    if tg_op='DELETE' or (to_jsonb(old)-array['updated_at','last_checked_at','last_error_code','status'])
      is distinct from (to_jsonb(new)-array['updated_at','last_checked_at','last_error_code','status']) then
      raise exception 'Finish or explicitly abandon first-boot setup before disconnecting' using errcode='55006'; end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connections_first_boot_operation_guard
  before update or delete on public.infrastructure_connections
  for each row execute function public.guard_first_boot_operation_connection();

create or replace function public.guard_first_boot_operation_secret()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=old.connection_id for update;
  if exists (select 1 from public.infrastructure_first_boot_operations where connection_id=old.connection_id
    and abandoned_at is null and (lease_expires_at>clock_timestamp() or firewall_post_attempted_at is not null)) then
    raise exception 'First-boot setup retains provider access' using errcode='55006'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
create trigger infrastructure_connection_secrets_first_boot_operation_guard
  before update or delete on public.infrastructure_connection_secrets
  for each row execute function public.guard_first_boot_operation_secret();

create or replace function public.guard_first_boot_operation_order()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare v_operation public.infrastructure_first_boot_operations%rowtype;
begin
  select * into v_operation from public.infrastructure_first_boot_operations where order_id=old.id;
  if not found then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='DELETE' then raise exception 'Retain first-boot resource evidence' using errcode='55006'; end if;
  -- Until fifth-resource cleanup is implemented, even abandonment must not
  -- let the old four-resource cleanup erase keys or release the billing claim.
  if v_operation.firewall_post_attempted_at is not null and new.status in ('cleaning','deleted','cleanup_abandoned') then
    raise exception 'First-boot firewall requires complete resource cleanup' using errcode='55006'; end if;
  if v_operation.abandoned_at is null
    and (v_operation.lease_expires_at>clock_timestamp() or v_operation.firewall_post_attempted_at is not null)
    and (to_jsonb(old)-array['updated_at','provider_observed_at','observed_server_status','last_error_code'])
      is distinct from (to_jsonb(new)-array['updated_at','provider_observed_at','observed_server_status','last_error_code']) then
    raise exception 'First-boot setup owns the capacity order' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger infrastructure_capacity_orders_first_boot_operation_guard
  before update or delete on public.infrastructure_capacity_orders
  for each row execute function public.guard_first_boot_operation_order();

create or replace function public.guard_first_boot_operation_revocation()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.phase in ('revoked','failed') and new.phase is distinct from old.phase and exists (
    select 1 from public.infrastructure_first_boot_operations where order_id=old.order_id
      and abandoned_at is null and lease_expires_at>clock_timestamp()
  ) then raise exception 'First-boot setup is still leased' using errcode='55006'; end if;
  return new;
end;
$$;
create trigger infrastructure_first_boot_enrollments_operation_guard
  before update on public.infrastructure_first_boot_enrollments
  for each row execute function public.guard_first_boot_operation_revocation();

revoke all on function public.is_valid_first_boot_firewall_receipt(jsonb,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.is_valid_first_boot_power_action(jsonb,text) from public,anon,authenticated;
revoke all on function public.guard_first_boot_operation() from public,anon,authenticated;
revoke all on function public.claim_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz) from public,anon,authenticated;
revoke all on function public.release_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid) from public,anon,authenticated;
revoke all on function public.abandon_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.guard_first_boot_operation_connection() from public,anon,authenticated;
revoke all on function public.guard_first_boot_operation_secret() from public,anon,authenticated;
revoke all on function public.guard_first_boot_operation_order() from public,anon,authenticated;
revoke all on function public.guard_first_boot_operation_revocation() from public,anon,authenticated;
grant execute on function public.is_valid_first_boot_firewall_receipt(jsonb,uuid,uuid,text,text) to service_role;
grant execute on function public.is_valid_first_boot_power_action(jsonb,text) to service_role;
grant execute on function public.claim_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text) to service_role;
grant execute on function public.checkpoint_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid,text,jsonb,timestamptz) to service_role;
grant execute on function public.release_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,uuid) to service_role;
grant execute on function public.abandon_hetzner_first_boot_operation(text,uuid,bigint,uuid,uuid,text,text,text,text) to service_role;
