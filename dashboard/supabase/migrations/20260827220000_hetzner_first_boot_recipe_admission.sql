-- Serialize the server POST's exact recipe with enrollment, disconnect and
-- cleanup. An older capacity-only caller must not send plain cloud-init after
-- another request has committed a first-boot capability for the same order.
-- This admits no purchase by itself and enables no public preparation flow.
create or replace function public.mark_hetzner_server_post_for_recipe(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint,
  p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text,
  p_attempted_at timestamptz, p_expected_enrollment jsonb
)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  v_order public.infrastructure_capacity_orders%rowtype;
  v_enrollment public.infrastructure_first_boot_enrollments%rowtype;
  v_has_enrollment boolean;
begin
  -- Same lock order as stage, first boot and cleanup. Check time AFTER the
  -- awaited locks as well; a queued database request is not fresh authority.
  perform id from public.infrastructure_connections where id = p_connection_id
    and user_id = p_user_id and provider = 'hetzner-cloud'
    and status = 'ready' and revision = p_expected_revision for update;
  if not found then return false; end if;
  select * into v_order from public.infrastructure_capacity_orders
    where id = p_order_id and user_id = p_user_id and connection_id = p_connection_id
      and active_connection_id = p_connection_id and connection_revision = p_expected_revision
      and provider = 'hetzner-cloud' and idempotency_key = p_idempotency_key for update;
  if not found then return false; end if;
  select * into v_enrollment from public.infrastructure_first_boot_enrollments
    where order_id = p_order_id for update;
  v_has_enrollment := found;
  if p_attempted_at is null or p_attempted_at < clock_timestamp() - interval '30 seconds'
    or p_attempted_at > clock_timestamp() + interval '5 seconds'
    or v_order.status <> 'creating' or v_order.server_post_attempted_at is not null
    or v_order.quote_expires_at <= clock_timestamp()
    or v_order.provider_ssh_key_status <> 'accepted'
    or v_order.provider_ssh_key_id is null
    or v_order.provider_ssh_key_id is distinct from p_provider_ssh_key_id then return false; end if;

  if p_expected_enrollment is null then
    -- Even expired/revoked enrollment evidence prevents silently switching an
    -- explicitly prepared order to an unrelated capacity-only recipe.
    if v_has_enrollment then return false; end if;
  else
    if not v_has_enrollment or v_enrollment.phase <> 'staged'
      or v_enrollment.expires_at <= clock_timestamp()
      or v_enrollment.issued_at > clock_timestamp() + interval '5 seconds'
      or v_enrollment.user_id is distinct from p_user_id
      or v_enrollment.connection_id is distinct from p_connection_id
      or v_enrollment.connection_revision is distinct from p_expected_revision
      or v_enrollment.capacity_idempotency_key is distinct from p_idempotency_key
      or v_enrollment.quote_fingerprint_sha256 is distinct from v_order.quote_fingerprint_sha256
      or p_expected_enrollment is distinct from jsonb_build_object(
        'attemptId', v_enrollment.attempt_id,
        'verifierSha256', v_enrollment.verifier_sha256,
        'recipeVersion', v_enrollment.recipe_version
      ) then return false; end if;
  end if;

  update public.infrastructure_capacity_orders set server_post_attempted_at = clock_timestamp(),
    provider_server_status = 'pending' where id = p_order_id;
  return true;
end;
$$;

-- Preserve the existing RPC signature for deployed callers. Its null recipe
-- expectation rejects any staged preparation, including a concurrent winner.
create or replace function public.mark_hetzner_cloud_server_post_attempted(
  p_user_id text, p_connection_id uuid, p_expected_revision bigint,
  p_order_id uuid, p_idempotency_key uuid, p_provider_ssh_key_id text,
  p_attempted_at timestamptz
)
returns boolean language sql security invoker set search_path = public, pg_temp as $$
  select public.mark_hetzner_server_post_for_recipe(p_user_id,p_connection_id,p_expected_revision,
    p_order_id,p_idempotency_key,p_provider_ssh_key_id,p_attempted_at,null);
$$;

revoke all on function public.mark_hetzner_server_post_for_recipe(text,uuid,bigint,uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.mark_hetzner_cloud_server_post_attempted(text,uuid,bigint,uuid,uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.mark_hetzner_server_post_for_recipe(text,uuid,bigint,uuid,uuid,text,timestamptz,jsonb) to service_role;
grant execute on function public.mark_hetzner_cloud_server_post_attempted(text,uuid,bigint,uuid,uuid,text,timestamptz) to service_role;
