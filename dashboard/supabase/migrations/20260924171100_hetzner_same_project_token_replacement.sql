-- Replace a Hetzner Cloud project token in place, at the same revision.
--
-- An expired or revoked Hetzner token used to have one stated fix: disconnect
-- and reconnect. Disconnecting erases the only saved private key for every
-- server Hivra created, and the secret-change triggers below revoked every
-- setup enrollment on the connection and refused any change at all once a
-- server had started setup. So a working, prepared server could not survive a
-- token rotation.
--
-- The application now proves, before calling this function, that the new token
-- authenticates, can see at least one server or generated SSH key Hivra
-- created through this connection (Hetzner ids are unique across projects),
-- and can write (a disclosed add-then-remove SSH key). This function then
-- swaps only the encrypted envelope, compared byte-for-byte with the one the
-- caller read, and keeps the connection revision. Every revision-bound record
-- (capacity orders and their generated SSH keys, first-boot enrollments,
-- provider-VM targets) therefore carries forward unchanged.
--
-- The swap marks itself with a transaction-local setting that only the two
-- first-boot secret triggers honour:
--   * revoke_first_boot_on_secret_change keeps enrollments (same project, same
--     revision, same server identities);
--   * guard_first_boot_operation_secret still refuses while a setup step holds
--     its lease, but no longer blocks a completed or paused setup.
-- The cleanup guard is unchanged: a server removal in progress still leases
-- the credential. Every other secret write keeps its original behaviour.

create or replace function public.replace_hetzner_cloud_connection_token(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_expected_encrypted_bundle text,
  p_encrypted_bundle text
)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
set lock_timeout = '2s'
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
begin
  if p_expected_encrypted_bundle is null
     or btrim(p_expected_encrypted_bundle) = ''
     or p_encrypted_bundle is null
     or btrim(p_encrypted_bundle) = ''
     or p_encrypted_bundle = p_expected_encrypted_bundle then
    raise exception 'Invalid encrypted token envelope' using errcode = '22023';
  end if;

  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and provider = 'hetzner-cloud'
  for update;
  if not found then
    return 'not_found';
  end if;
  if v_connection.revision <> p_expected_revision then
    return 'connection_changed';
  end if;

  if exists (
    select 1 from public.infrastructure_capacity_orders
    where active_connection_id = p_connection_id
      and user_id = p_user_id
      and status = 'cleaning'
  ) then
    return 'cleanup_in_progress';
  end if;
  if exists (
    select 1 from public.infrastructure_first_boot_operations
    where connection_id = p_connection_id
      and abandoned_at is null
      and lease_expires_at > clock_timestamp()
  ) then
    return 'setup_step_running';
  end if;

  perform set_config('hivra.same_project_token_replacement', p_connection_id::text, true);
  update public.infrastructure_connection_secrets
    set encrypted_bundle = p_encrypted_bundle,
        key_version = 2
    where connection_id = p_connection_id
      and user_id = p_user_id
      and encrypted_bundle = p_expected_encrypted_bundle;
  if not found then
    perform set_config('hivra.same_project_token_replacement', '', true);
    return 'envelope_changed';
  end if;
  perform set_config('hivra.same_project_token_replacement', '', true);
  return 'replaced';
end;
$$;

create or replace function public.revoke_first_boot_on_secret_change()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  perform id from public.infrastructure_connections where id = old.connection_id for update;
  -- A proven same-project token swap keeps the revision and every server
  -- identity, so the original enrollments stay valid.
  if tg_op = 'UPDATE'
     and coalesce(current_setting('hivra.same_project_token_replacement', true), '') = old.connection_id::text then
    return new;
  end if;
  update public.infrastructure_first_boot_enrollments set phase = 'revoked',encrypted_token = null,
    updated_at = clock_timestamp() where connection_id = old.connection_id and phase not in ('revoked','failed');
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.guard_first_boot_operation_secret()
returns trigger language plpgsql set search_path=public,pg_temp as $$
begin
  perform id from public.infrastructure_connections where id=old.connection_id for update;
  if tg_op='UPDATE'
     and coalesce(current_setting('hivra.same_project_token_replacement', true), '') = old.connection_id::text then
    -- Same-project swap: refuse only while a setup step holds its lease.
    if exists (select 1 from public.infrastructure_first_boot_operations
      where connection_id=old.connection_id and abandoned_at is null
        and lease_expires_at>clock_timestamp()) then
      raise exception 'First-boot setup retains provider access' using errcode='55006';
    end if;
    return new;
  end if;
  if public.first_boot_retains_connection(old.connection_id) then
    raise exception 'First-boot setup retains provider access' using errcode='55006'; end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.replace_hetzner_cloud_connection_token(
  text, uuid, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.replace_hetzner_cloud_connection_token(
  text, uuid, bigint, text, text
) to service_role;

comment on function public.replace_hetzner_cloud_connection_token(
  text, uuid, bigint, text, text
) is
  'Service-role-only compare-and-swap of a Hetzner project token envelope at the same connection revision, after the application proved the new token reaches the same project and can write. Keeps generated SSH keys, setup enrollments and targets; refuses during cleanup or a leased setup step.';
