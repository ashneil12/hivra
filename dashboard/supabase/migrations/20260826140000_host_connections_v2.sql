-- Compatibility-safe host-first infrastructure connections.
--
-- Existing `proxmox` rows and the legacy creation RPC remain unchanged so an
-- older dashboard can continue to read and mutate them during rollout. New
-- generic host rows are deliberately created in Simple mode with no inferred
-- isolation driver and no deployment target. Read-only discovery is the only
-- operation allowed to decide what preparation may be offered next.

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_provider_check;

alter table public.infrastructure_connections
  add constraint infrastructure_connections_provider_check
  check (provider in ('proxmox', 'host')) not valid;

alter table public.infrastructure_connections
  validate constraint infrastructure_connections_provider_check;

create or replace function public.create_host_infrastructure_connection(
  p_user_id text,
  p_name text,
  p_ssh_host text,
  p_ssh_port integer,
  p_ssh_user text,
  p_ssh_host_fingerprint_sha256 text,
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
    'host',
    'self-managed',
    'simple',
    'pending',
    p_ssh_host,
    p_ssh_port,
    p_ssh_user,
    p_ssh_host_fingerprint_sha256,
    '{}'::jsonb
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

revoke all on function public.create_host_infrastructure_connection(
  text, text, text, integer, text, text, text, smallint
) from public, anon, authenticated;

grant execute on function public.create_host_infrastructure_connection(
  text, text, text, integer, text, text, text, smallint
) to service_role;

comment on table public.infrastructure_connections is
  'Owner-scoped non-secret metadata for user-provided hosts. A host connection is not launch authority until a supported driver produces current target evidence.';

comment on function public.create_host_infrastructure_connection(
  text, text, text, integer, text, text, text, smallint
) is
  'Atomically creates a generic owner-scoped host connection and encrypted SSH credential envelope. It creates no deployment target or launch authority.';
