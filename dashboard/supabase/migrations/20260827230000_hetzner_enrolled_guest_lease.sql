-- A consumed one-time enrollment token and a persisted host identity have
-- different lifetimes. This private lease authorizes only current-owner work
-- on an already enrolled original guest; it cannot enroll/rotate a key, renew
-- the expired token, replay boot, or publish a ready deployment target.
-- Reuse the existing connection -> order -> enrollment -> operation locks and
-- journal so cleanup, disconnect and abandonment remain mutually exclusive.
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
  if not found or v_enrollment.phase <> 'enrolled' or v_enrollment.recipe_version <> '2026.08.27.1'
    or v_enrollment.provider_server_id is distinct from p_server or v_enrollment.encrypted_token is not null
    or v_enrollment.enrolled_at is null or v_enrollment.enrolled_at < v_enrollment.issued_at
    or v_enrollment.enrolled_at >= v_enrollment.expires_at
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
revoke all on function public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_hetzner_enrolled_guest_operation(text,uuid,bigint,uuid,uuid,text,text) to service_role;
