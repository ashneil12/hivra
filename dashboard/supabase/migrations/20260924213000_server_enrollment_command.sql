-- My server: one-command enrollment (design and threat model:
-- docs/superpowers/specs/2026-09-24-server-enrollment-command.md).
--
-- 1. Connections gain ssh_privilege ('login' | 'sudo') and ssh_host_key_type
--    (null | 'ssh-ed25519'). Existing rows keep 'login' and null, so every
--    existing host runs exactly as before. ssh_privilege is revision-bound:
--    changing it is an operational edit that supersedes evidence.
-- 2. Host discovery snapshots accept contract version 2, which records how
--    the connection reached root (privilegeVia) and whether a non-root login
--    has passwordless sudo. SQL refuses a v2 snapshot whose privilegeVia
--    differs from the connection at commit. Old code keeps writing v1.
-- 3. Private enrollment ledger and append-only receipts. The code itself is
--    never stored, only its purpose-bound sha256. Every write goes through a
--    SECURITY DEFINER function below; the service role can only read, and
--    delete enrollments (retention, account deletion). A report makes nothing
--    trusted: only the owner's Yes (or a verified Replace) creates or changes
--    a connection.
--
-- Rerun-safe: every object is created with if-not-exists / or-replace, and
-- constraints are dropped before they are added.

-- ---------------------------------------------------------------------------
-- 1. Connection privilege and host key type
-- ---------------------------------------------------------------------------

alter table public.infrastructure_connections
  add column if not exists ssh_privilege text not null default 'login',
  add column if not exists ssh_host_key_type text;

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_ssh_privilege_check,
  add constraint infrastructure_connections_ssh_privilege_check
    check (ssh_privilege in ('login', 'sudo')
      -- Only generic host connections run host scripts through sudo. Legacy
      -- Proxmox rows and provider-API rows stay 'login'.
      and (ssh_privilege = 'login' or provider = 'host'));

alter table public.infrastructure_connections
  drop constraint if exists infrastructure_connections_ssh_host_key_type_check,
  add constraint infrastructure_connections_ssh_host_key_type_check
    check (ssh_host_key_type is null or ssh_host_key_type = 'ssh-ed25519');

comment on column public.infrastructure_connections.ssh_privilege is
  'How host scripts reach root: login (the SSH user is root, or today''s non-root behaviour) or sudo (every host script runs through the fixed sudo transport). Revision-bound.';
comment on column public.infrastructure_connections.ssh_host_key_type is
  'When set, SSH to this connection offers only this host key algorithm (the enrolled Ed25519 key), so a server presenting another key type is refused before authentication.';

drop function if exists public.create_host_infrastructure_connection(
  text, text, text, integer, text, text, text, smallint
);

create or replace function public.create_host_infrastructure_connection(
  p_user_id text,
  p_name text,
  p_ssh_host text,
  p_ssh_port integer,
  p_ssh_user text,
  p_ssh_host_fingerprint_sha256 text,
  p_encrypted_bundle text,
  p_key_version smallint,
  p_ssh_privilege text default 'login',
  p_ssh_host_key_type text default null
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
    ssh_privilege,
    ssh_host_key_type,
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
    coalesce(p_ssh_privilege, 'login'),
    p_ssh_host_key_type,
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
  text, text, text, integer, text, text, text, smallint, text, text
) from public, anon, authenticated;
grant execute on function public.create_host_infrastructure_connection(
  text, text, text, integer, text, text, text, smallint, text, text
) to service_role;

-- Same contract as 20260826130000, plus the two new revision-bound columns.
-- A new pinned fingerprint without a stated key type clears the old type.
create or replace function public.update_infrastructure_connection(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_patch jsonb,
  p_operational_change boolean,
  p_rotate_credentials boolean,
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
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;

  if not found then return; end if;

  if v_connection.preflight_run_id is not null then
    raise exception 'infrastructure connection has an active preparation or preflight lease'
      using errcode = '55006';
  end if;

  if p_rotate_credentials and not p_operational_change then
    raise exception 'credential rotation must be operational'
      using errcode = '22023';
  end if;
  if not p_operational_change
    and (coalesce(p_patch, '{}'::jsonb) - 'name') <> '{}'::jsonb
  then
    raise exception 'non-operational connection update may only change name'
      using errcode = '22023';
  end if;
  if p_operational_change and exists (
    select 1
    from public.hivra_agents
    where infrastructure_connection_id = p_connection_id
      and user_id = p_user_id
      and deployment_mode = 'self-managed'
      and status <> 'deleted'
  ) then
    raise exception 'infrastructure connection is bound to active Hivra agents'
      using errcode = '55006';
  end if;

  update public.infrastructure_connections
  set
    name = case when p_patch ? 'name' then p_patch ->> 'name' else name end,
    setup_mode = case when p_patch ? 'setup_mode' then p_patch ->> 'setup_mode' else setup_mode end,
    ssh_host = case when p_patch ? 'ssh_host' then p_patch ->> 'ssh_host' else ssh_host end,
    ssh_port = case when p_patch ? 'ssh_port' then (p_patch ->> 'ssh_port')::integer else ssh_port end,
    ssh_user = case when p_patch ? 'ssh_user' then p_patch ->> 'ssh_user' else ssh_user end,
    ssh_host_fingerprint_sha256 = case
      when p_patch ? 'ssh_host_fingerprint_sha256'
        then p_patch ->> 'ssh_host_fingerprint_sha256'
      else ssh_host_fingerprint_sha256
    end,
    ssh_privilege = case
      when p_patch ? 'ssh_privilege' then p_patch ->> 'ssh_privilege'
      else ssh_privilege
    end,
    ssh_host_key_type = case
      when p_patch ? 'ssh_host_key_type' then p_patch ->> 'ssh_host_key_type'
      when p_patch ? 'ssh_host_fingerprint_sha256'
        and p_patch ->> 'ssh_host_fingerprint_sha256' is distinct from ssh_host_fingerprint_sha256
        then null
      else ssh_host_key_type
    end,
    config = case when p_patch ? 'config' then p_patch -> 'config' else config end,
    status = case when p_operational_change then 'pending' else status end,
    preflight_run_id = case when p_operational_change then null else preflight_run_id end,
    last_checked_at = case when p_operational_change then null else last_checked_at end,
    last_error_code = case when p_operational_change then null else last_error_code end,
    revision = case when p_operational_change then revision + 1 else revision end
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  returning * into v_connection;

  if p_rotate_credentials then
    update public.infrastructure_connection_secrets
    set encrypted_bundle = p_encrypted_bundle,
        key_version = p_key_version
    where connection_id = p_connection_id
      and user_id = p_user_id;
    if not found then
      raise exception 'infrastructure credential row missing' using errcode = 'P0002';
    end if;
  end if;

  if p_operational_change then
    update public.deployment_targets
    set status = 'unavailable',
        capabilities = jsonb_set(
          coalesce(capabilities, '{}'::jsonb),
          '{launchReady}',
          'false'::jsonb,
          true
        ),
        supported_isolation_drivers = '{}'::text[],
        isolation_class = null,
        last_error_code = 'PREFLIGHT_SUPERSEDED'
    where connection_id = p_connection_id
      and user_id = p_user_id;
  elsif p_patch ? 'name' then
    update public.deployment_targets
    set display_name = left(v_connection.name || ' / ' || external_id, 128)
    where connection_id = p_connection_id
      and user_id = p_user_id;
  end if;

  return next v_connection;
end;
$$;

revoke all on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) from public, anon, authenticated;
grant execute on function public.update_infrastructure_connection(
  text, uuid, bigint, jsonb, boolean, boolean, text, smallint
) to service_role;

-- ---------------------------------------------------------------------------
-- 2. Host discovery contract version 2
-- ---------------------------------------------------------------------------

alter table public.infrastructure_host_discovery_snapshots
  drop constraint if exists infrastructure_host_discovery_snapshots_contract_version_check,
  add constraint infrastructure_host_discovery_snapshots_contract_version_check
    check (contract_version in (1, 2));

create or replace function public.complete_infrastructure_host_discovery(
  p_user_id text,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_run_id uuid,
  p_observed_at timestamptz,
  p_expires_at timestamptz,
  p_host_identity_digest text,
  p_snapshot jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_connection public.infrastructure_connections%rowtype;
  v_run public.infrastructure_host_discovery_runs%rowtype;
  v_now timestamptz := statement_timestamp();
  v_version text;
begin
  select * into v_connection
  from public.infrastructure_connections
  where id = p_connection_id
    and user_id = p_user_id
    and revision = p_expected_revision
  for update;
  if not found then return false; end if;

  select * into v_run
  from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connection_revision = p_expected_revision
    and run_id = p_run_id
  for update;
  if not found or v_run.lease_expires_at <= v_now then return false; end if;

  v_version := p_snapshot ->> 'contractVersion';
  if p_snapshot is null
    or jsonb_typeof(p_snapshot) <> 'object'
    or octet_length(p_snapshot::text) > 65536
    or p_observed_at < v_now - interval '2 minutes'
    or p_observed_at > v_now + interval '1 minute'
    or p_expires_at <> p_observed_at + interval '15 minutes'
    or p_expires_at <= v_now
    or p_host_identity_digest !~ '^[0-9a-f]{64}$'
    or p_snapshot ->> 'discoveryId' is distinct from p_run_id::text
    or p_snapshot ->> 'connectionId' is distinct from p_connection_id::text
    or p_snapshot ->> 'connectionRevision' is distinct from p_expected_revision::text
    or p_snapshot ->> 'connectionProvider' is distinct from v_connection.provider
    or v_version is null
    or v_version not in ('1', '2')
    or p_snapshot ->> 'hostIdentityDigest' is distinct from p_host_identity_digest
    or jsonb_typeof(p_snapshot -> 'host') is distinct from 'object'
    or jsonb_typeof(p_snapshot -> 'engines') is distinct from 'array'
    or (
      case
        when jsonb_typeof(p_snapshot -> 'engines') = 'array'
          then jsonb_array_length(p_snapshot -> 'engines') <> 9
        else true
      end
    )
    -- v1 was only ever taken over the SSH login and carries no privilege
    -- fields. v2 must say how it reached root, and that must be the
    -- connection's own privilege at commit.
    or (v_version = '1' and (
      p_snapshot #> '{host,environment}' ? 'privilegeVia'
      or p_snapshot #> '{host,environment}' ? 'passwordlessSudo'))
    or (v_version = '2' and (
      p_snapshot #>> '{host,environment,privilegeVia}' is distinct from v_connection.ssh_privilege
      or not (p_snapshot #> '{host,environment}' ? 'passwordlessSudo')))
  then
    raise exception 'host discovery snapshot is invalid' using errcode = '22023';
  end if;

  insert into public.infrastructure_host_discovery_snapshots (
    id,
    connection_id,
    user_id,
    connection_revision,
    contract_version,
    observed_at,
    expires_at,
    host_identity_digest,
    snapshot
  ) values (
    p_run_id,
    p_connection_id,
    p_user_id,
    p_expected_revision,
    v_version::smallint,
    p_observed_at,
    p_expires_at,
    p_host_identity_digest,
    p_snapshot
  );

  delete from public.infrastructure_host_discovery_runs
  where connection_id = p_connection_id
    and user_id = p_user_id
    and connection_revision = p_expected_revision
    and run_id = p_run_id;
  if not found then
    raise exception 'host discovery lease changed during completion' using errcode = '55000';
  end if;

  return true;
end;
$$;

revoke all on function public.complete_infrastructure_host_discovery(
  text, uuid, bigint, uuid, timestamptz, timestamptz, text, jsonb
) from public, anon, authenticated;
grant execute on function public.complete_infrastructure_host_discovery(
  text, uuid, bigint, uuid, timestamptz, timestamptz, text, jsonb
) to service_role;

-- ---------------------------------------------------------------------------
-- 3. Enrollment ledger
-- ---------------------------------------------------------------------------

-- The three words both the terminal and "Is this your server?" show. The app
-- chooses them with a CSPRNG; SQL only checks them against this fixed list,
-- which must stay identical to SERVER_ENROLLMENT_WORDS in
-- src/lib/infrastructure/server-enrollment-words.ts (a test compares them).
create or replace function public.server_enrollment_word_list()
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select array[
    'acorn','amber','anchor','apple','apricot','arbor','arrow','aspen','atlas','autumn',
    'badge','bamboo','banjo','barley','basil','beacon','beaver','berry','birch','bison',
    'blossom','bonsai','breeze','brick','bridge','brook','bronze','bubble','buffalo','butter',
    'cabin','cactus','camel','canal','candle','canoe','canyon','carbon','cargo','carrot',
    'castle','cedar','cello','chalk','cherry','cider','cinder','citrus','clover','cobalt',
    'cocoa','comet','copper','coral','cotton','cougar','coyote','crane','crater','cricket',
    'crystal','cypress','daisy','dawn','delta','denim','desert','dolphin','dove','drift',
    'dune','eagle','easel','echo','ember','emerald','falcon','feather','fennel','fern',
    'ferry','fiddle','fig','finch','fjord','flame','flint','forest','fossil','fox',
    'galaxy','garden','garnet','gecko','geyser','ginger','glacier','globe','gondola','granite',
    'grape','gravel','guitar','harbor','harvest','hazel','heron','hickory','honey','horizon',
    'husky','iris','island','ivory','jade','jasmine','jelly','jungle','juniper','kayak',
    'kelp','kettle','kiwi','koala','lagoon','lantern','lark','lava','lemon','lentil',
    'lichen','lilac','lily','linen','lotus','lunar','lynx','magnet','mango','maple',
    'marble','meadow','melon','mesa','meteor','mint','mist','moose','mosaic','moss',
    'muffin','nectar','nickel','nomad','nutmeg','oak','oasis','ocean','olive','onyx',
    'opal','orbit','orchid','osprey','otter','owl','paddle','palm','panda','papaya',
    'parrot','peach','pearl','pebble','pelican','pepper','petal','piano','pine','pixel',
    'planet','plaza','plum','polar','pond','poppy','prairie','prism','puffin','pumpkin',
    'quartz','quill','quince','rabbit','radish','rain','raven','reef','ridge','river',
    'robin','rocket','rose','ruby','saddle','saffron','sage','salmon','sand','satin',
    'shell','sierra','silver','slate','sloth','snow','solar','sparrow','spice','spruce',
    'star','stone','storm','summit','sunset','swan','tango','teal','thistle','thunder',
    'tiger','timber','topaz','torch','tulip','tundra','turtle','umber','valley','velvet',
    'violet','walnut','walrus','willow','winter','wombat','wren','yarrow','yeti','zebra',
    'zephyr','zinc','lime','cloud','violin','raft'
  ]::text[];
$$;

create or replace function public.is_server_enrollment_words(p_words text)
returns boolean
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_parts text[];
begin
  if p_words is null or p_words !~ '^[a-z]{2,10}-[a-z]{2,10}-[a-z]{2,10}$' then return false; end if;
  v_parts := string_to_array(p_words, '-');
  return array_length(v_parts, 1) = 3
    and v_parts[1] = any(public.server_enrollment_word_list())
    and v_parts[2] = any(public.server_enrollment_word_list())
    and v_parts[3] = any(public.server_enrollment_word_list());
end;
$$;

-- Lowercase hex SHA-256 of an Ed25519 key's wire blob: the form
-- infrastructure_connections pins. Null for anything that isn't one.
create or replace function public.server_enrollment_key_hex_fingerprint(p_key text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
  if p_key is null or p_key !~ '^ssh-ed25519 [A-Za-z0-9+/]{68}$' then return null; end if;
  return encode(sha256(decode(split_part(p_key, ' ', 2), 'base64')), 'hex');
exception when others then return null;
end;
$$;

create table if not exists public.infrastructure_server_enrollments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null check (char_length(user_id) between 1 and 256),
  code_sha256 text not null unique check (code_sha256 ~ '^[0-9a-f]{64}$'),
  phase text not null check (phase in (
    'issued', 'reported', 'unsupported', 'confirmed', 'rejected', 'cancelled', 'expired'
  )),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  script_version text not null check (script_version ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.[0-9]{1,3}$'),
  admin_public_key text not null,
  admin_key_fingerprint text not null,
  sealed_admin_private_key text,
  script_fetches integer not null default 0 check (script_fetches between 0 and 20),
  last_fetched_at timestamptz,
  refused_reports integer not null default 0 check (refused_reports between 0 and 10),
  last_refusal text check (last_refusal in ('private_address', 'ipv4_required', 'invalid_report')),
  last_refused_at timestamptz,
  report_kind text check (report_kind in ('enrolled', 'unsupported')),
  reported_at timestamptz,
  confirm_by timestamptz,
  report_digest text check (report_digest ~ '^[0-9a-f]{64}$'),
  -- The address Hivra itself saw the report come from (never one the report
  -- claims). Null when the platform gave no usable address.
  observed_address text check (observed_address is null or char_length(observed_address) between 2 and 45),
  ssh_port integer check (ssh_port between 1 and 65535),
  host_public_key text,
  host_fingerprint_sha256 text,
  facts jsonb check (facts is null or (jsonb_typeof(facts) = 'object' and octet_length(facts::text) <= 2048)),
  consent text check (consent in ('terminal', 'no_terminal')),
  reenrollment boolean,
  words text check (words is null or public.is_server_enrollment_words(words)),
  replacement_run_id uuid,
  replacement_lease_expires_at timestamptz,
  replacement_connection_id uuid,
  replacement_expected_revision bigint,
  replacement_mode text check (replacement_mode in ('key', 'switch')),
  replacement_attempts integer not null default 0 check (replacement_attempts between 0 and 5),
  last_replacement_failure text check (last_replacement_failure in (
    'host_key_mismatch', 'connection_failed', 'authentication_failed',
    'sudo_unavailable', 'not_root', 'connection_changed', 'proxmox_needs_root'
  )),
  decided_at timestamptz,
  outcome text check (outcome in ('connected', 'replaced_access')),
  replaced_from_revision bigint,
  connection_id uuid references public.infrastructure_connections (id) on delete set null,
  connection_removed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint infrastructure_server_enrollments_ttl check (expires_at = issued_at + interval '15 minutes'),
  constraint infrastructure_server_enrollments_admin_key check (
    public.is_valid_first_boot_host_key(admin_public_key, admin_key_fingerprint) is true
  ),
  constraint infrastructure_server_enrollments_host_key check (
    host_public_key is null
    or public.is_valid_first_boot_host_key(host_public_key, host_fingerprint_sha256) is true
  ),
  -- The sealed private key exists only while a Yes can still use it.
  constraint infrastructure_server_enrollments_secret_state check (
    ((phase in ('issued', 'reported') and sealed_admin_private_key is not null
        and octet_length(sealed_admin_private_key) between 64 and 16384)
      or (phase not in ('issued', 'reported') and sealed_admin_private_key is null)) is true
  ),
  constraint infrastructure_server_enrollments_phase_state check ((
    (phase = 'issued' and report_kind is null and reported_at is null and report_digest is null
      and decided_at is null and outcome is null and connection_id is null and words is null)
    or (phase = 'reported' and report_kind = 'enrolled' and reported_at is not null
      and confirm_by = reported_at + interval '30 minutes' and report_digest is not null
      and host_public_key is not null and ssh_port is not null and facts is not null
      and consent is not null and words is not null and decided_at is null and outcome is null)
    or (phase = 'unsupported' and report_kind = 'unsupported' and reported_at is not null
      and report_digest is not null and host_public_key is null and facts is not null
      and consent is not null and words is null and decided_at is not null and outcome is null
      and connection_id is null)
    or (phase = 'confirmed' and report_kind = 'enrolled' and decided_at is not null
      and outcome is not null and host_public_key is not null
      and (outcome = 'connected') = (replaced_from_revision is null))
    or (phase in ('rejected', 'cancelled', 'expired') and decided_at is not null
      and outcome is null and connection_id is null)
  ) is true),
  constraint infrastructure_server_enrollments_lease_shape check (
    (replacement_run_id is null) = (replacement_lease_expires_at is null)
  )
);

-- An earlier apply of this file created the inline check with a shorter
-- list; keep the current one on a rerun.
alter table public.infrastructure_server_enrollments
  drop constraint if exists infrastructure_server_enrollments_last_replacement_failure_check,
  add constraint infrastructure_server_enrollments_last_replacement_failure_check
    check (last_replacement_failure in (
      'host_key_mismatch', 'connection_failed', 'authentication_failed',
      'sudo_unavailable', 'not_root', 'connection_changed', 'proxmox_needs_root'));

create index if not exists infrastructure_server_enrollments_user_idx
  on public.infrastructure_server_enrollments (user_id, issued_at desc);
-- Not unique: every enrollment that connected or replaced a connection's
-- access is one of its receipts.
create index if not exists infrastructure_server_enrollments_connection_idx
  on public.infrastructure_server_enrollments (connection_id)
  where connection_id is not null;
create index if not exists infrastructure_server_enrollments_phase_idx
  on public.infrastructure_server_enrollments (phase, expires_at);

alter table public.infrastructure_server_enrollments enable row level security;
revoke all on public.infrastructure_server_enrollments from public, anon, authenticated, service_role;
grant select, delete on public.infrastructure_server_enrollments to service_role;

create table if not exists public.infrastructure_server_enrollment_events (
  id bigint generated always as identity primary key,
  enrollment_id uuid not null
    references public.infrastructure_server_enrollments (id) on delete cascade,
  user_id text not null,
  kind text not null check (kind in (
    'issued', 'script_served', 'refused_report', 'reported', 'unsupported', 'confirmed',
    'connection_created', 'rejected', 'cancelled', 'expired', 'replacement_verified',
    'replacement_refused', 'access_replaced', 'identity_mismatch'
  )),
  actor text not null check (actor in ('owner', 'server', 'hivra')),
  script_version text,
  observed_address text,
  host_fingerprint_sha256 text,
  detail text check (detail is null or detail ~ '^[a-z0-9_]{1,48}$'),
  occurred_at timestamptz not null default clock_timestamp()
);

create index if not exists infrastructure_server_enrollment_events_enrollment_idx
  on public.infrastructure_server_enrollment_events (enrollment_id, id);
create unique index if not exists infrastructure_server_enrollment_events_once_idx
  on public.infrastructure_server_enrollment_events (enrollment_id, kind)
  where kind in ('issued', 'reported', 'unsupported', 'confirmed', 'rejected', 'cancelled',
    'expired', 'connection_created', 'access_replaced', 'identity_mismatch');

alter table public.infrastructure_server_enrollment_events enable row level security;
revoke all on public.infrastructure_server_enrollment_events from public, anon, authenticated, service_role;
grant select on public.infrastructure_server_enrollment_events to service_role;
-- Supabase's default privileges also grant the identity sequence; nobody
-- inserts receipts except the SECURITY DEFINER functions below.
revoke all on sequence public.infrastructure_server_enrollment_events_id_seq
  from public, anon, authenticated, service_role;

-- Receipts are append-only. Even the table owner can't update one, and one is
-- deleted only by the cascade from its enrollment (the retention sweep or
-- account deletion): a direct DELETE runs this trigger at depth 1.
create or replace function public.guard_server_enrollment_event()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Enrollment receipts cannot be changed' using errcode = '55006';
  end if;
  if pg_trigger_depth() <= 1 then
    raise exception 'Enrollment receipts go only with their enrollment' using errcode = '55006';
  end if;
  return old;
end;
$$;

drop trigger if exists infrastructure_server_enrollment_event_guard
  on public.infrastructure_server_enrollment_events;
create trigger infrastructure_server_enrollment_event_guard
  before update or delete on public.infrastructure_server_enrollment_events
  for each row execute function public.guard_server_enrollment_event();

-- TRUNCATE skips row triggers and cascades, so it gets its own guard: not
-- even the owner can empty the receipts (a TRUNCATE of enrollments ... CASCADE
-- fires this too).
create or replace function public.guard_server_enrollment_event_truncate()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'Enrollment receipts go only with their enrollment' using errcode = '55006';
end;
$$;

drop trigger if exists infrastructure_server_enrollment_event_truncate_guard
  on public.infrastructure_server_enrollment_events;
create trigger infrastructure_server_enrollment_event_truncate_guard
  before truncate on public.infrastructure_server_enrollment_events
  for each statement execute function public.guard_server_enrollment_event_truncate();

-- Allowed transitions and the only columns each one may change.
create or replace function public.guard_server_enrollment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_allowed text[] := array['updated_at'];
begin
  if tg_op = 'DELETE' then return old; end if;
  -- The connection foreign key clears connection_id when a connection is
  -- deleted; that is the only change it makes.
  if new.phase = old.phase and new.connection_id is null and old.connection_id is not null
    and (to_jsonb(new) - array['connection_id', 'updated_at'])
      = (to_jsonb(old) - array['connection_id', 'updated_at']) then
    return new;
  end if;
  if new.phase is distinct from old.phase and not (
    (old.phase = 'issued' and new.phase in ('reported', 'unsupported', 'cancelled', 'expired'))
    or (old.phase = 'reported' and new.phase in ('confirmed', 'rejected', 'cancelled', 'expired'))
  ) then
    raise exception 'Invalid server enrollment transition' using errcode = '55006';
  end if;
  if new.sealed_admin_private_key is distinct from old.sealed_admin_private_key
    and new.sealed_admin_private_key is not null then
    raise exception 'The enrollment key cannot be replaced' using errcode = '55006';
  end if;
  if old.phase = 'issued' and new.phase = 'issued' then
    v_allowed := v_allowed || array['script_fetches', 'last_fetched_at', 'refused_reports',
      'last_refusal', 'last_refused_at'];
    if new.script_fetches < old.script_fetches or new.refused_reports < old.refused_reports then
      raise exception 'Enrollment counters only grow' using errcode = '55006';
    end if;
  elsif old.phase = 'issued' and new.phase in ('reported', 'unsupported') then
    v_allowed := v_allowed || array['phase', 'report_kind', 'reported_at', 'confirm_by',
      'report_digest', 'observed_address', 'ssh_port', 'host_public_key',
      'host_fingerprint_sha256', 'facts', 'consent', 'reenrollment', 'words', 'decided_at',
      'sealed_admin_private_key'];
  elsif old.phase = 'reported' and new.phase = 'reported' then
    v_allowed := v_allowed || array['replacement_run_id', 'replacement_lease_expires_at',
      'replacement_connection_id', 'replacement_expected_revision', 'replacement_mode',
      'replacement_attempts', 'last_replacement_failure'];
    if new.replacement_attempts < old.replacement_attempts then
      raise exception 'Enrollment counters only grow' using errcode = '55006';
    end if;
  elsif old.phase = 'reported' and new.phase = 'confirmed' then
    v_allowed := v_allowed || array['phase', 'decided_at', 'outcome', 'replaced_from_revision',
      'connection_id', 'sealed_admin_private_key', 'replacement_run_id',
      'replacement_lease_expires_at', 'replacement_connection_id', 'replacement_expected_revision',
      'replacement_mode', 'last_replacement_failure'];
  elsif new.phase in ('rejected', 'cancelled', 'expired') and new.phase <> old.phase then
    v_allowed := v_allowed || array['phase', 'decided_at', 'sealed_admin_private_key',
      'replacement_run_id', 'replacement_lease_expires_at', 'replacement_connection_id',
      'replacement_expected_revision', 'replacement_mode'];
  elsif old.phase = 'confirmed' and new.phase = 'confirmed' then
    v_allowed := v_allowed || array['connection_removed_at'];
    if old.connection_removed_at is not null then
      raise exception 'Enrollment receipts are final' using errcode = '55006';
    end if;
  else
    raise exception 'Enrollment is final' using errcode = '55006';
  end if;
  if (to_jsonb(new) - v_allowed) is distinct from (to_jsonb(old) - v_allowed) then
    raise exception 'Enrollment binding and identity are immutable' using errcode = '55006';
  end if;
  return new;
end;
$$;

drop trigger if exists infrastructure_server_enrollment_guard
  on public.infrastructure_server_enrollments;
create trigger infrastructure_server_enrollment_guard
  before update or delete on public.infrastructure_server_enrollments
  for each row execute function public.guard_server_enrollment();

revoke all on function public.guard_server_enrollment() from public, anon, authenticated, service_role;
revoke all on function public.guard_server_enrollment_event() from public, anon, authenticated, service_role;
revoke all on function public.guard_server_enrollment_event_truncate() from public, anon, authenticated, service_role;

-- Internal: append one receipt.
create or replace function public.append_server_enrollment_event(
  p_enrollment public.infrastructure_server_enrollments,
  p_kind text,
  p_actor text,
  p_detail text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.infrastructure_server_enrollment_events (
    enrollment_id, user_id, kind, actor, script_version, observed_address,
    host_fingerprint_sha256, detail
  ) values (
    p_enrollment.id, p_enrollment.user_id, p_kind, p_actor, p_enrollment.script_version,
    case when p_kind in ('reported', 'unsupported') then p_enrollment.observed_address end,
    case when p_kind in ('reported', 'confirmed', 'connection_created', 'access_replaced',
      'replacement_verified', 'replacement_refused', 'identity_mismatch')
      then p_enrollment.host_fingerprint_sha256 end,
    p_detail
  );
end;
$$;

-- Connections in this account whose pinned identity is this Ed25519 key:
-- SSH connections by pinned fingerprint, and servers Hivra created on
-- Hetzner by their enrolled first-boot identity. Other accounts are never
-- searched.
create or replace function public.server_enrollment_identity_matches(p_user_id text, p_host_public_key text)
returns table (connection_id uuid, provider text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select c.id, c.provider
  from public.infrastructure_connections c
  where c.user_id = p_user_id
    and c.provider in ('host', 'proxmox')
    and c.ssh_host_fingerprint_sha256 = public.server_enrollment_key_hex_fingerprint(p_host_public_key)
  union
  select c.id, c.provider
  from public.infrastructure_first_boot_enrollments f
  join public.infrastructure_connections c on c.id = f.connection_id and c.user_id = f.user_id
  where f.user_id = p_user_id
    and f.phase = 'enrolled'
    and f.host_public_key = p_host_public_key;
$$;

create or replace function public.issue_server_enrollment(
  p_user_id text,
  p_code_sha256 text,
  p_script_version text,
  p_admin_public_key text,
  p_admin_key_fingerprint text,
  p_sealed_admin_private_key text,
  p_replace_enrollment_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
  v_active integer;
  v_recent integer;
begin
  if p_user_id is null or char_length(p_user_id) not between 1 and 256
    or p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$'
    or p_script_version is null
    or public.is_valid_first_boot_host_key(p_admin_public_key, p_admin_key_fingerprint) is not true
    or p_sealed_admin_private_key is null
    or octet_length(p_sealed_admin_private_key) not between 64 and 16384 then
    raise exception 'Invalid server enrollment' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('hivra-server-enrollment:' || p_user_id, 0));

  -- "Get a new command" cancels the code it replaces, unless a server
  -- already reported with it.
  if p_replace_enrollment_id is not null then
    select * into v_row from public.infrastructure_server_enrollments
      where id = p_replace_enrollment_id and user_id = p_user_id for update;
    if found and v_row.phase = 'issued' then
      update public.infrastructure_server_enrollments
        set phase = case when expires_at <= v_now then 'expired' else 'cancelled' end,
            decided_at = case when expires_at <= v_now then expires_at else v_now end,
            sealed_admin_private_key = null, updated_at = v_now
        where id = v_row.id
        returning * into v_row;
      perform public.append_server_enrollment_event(v_row, v_row.phase, 'owner');
    end if;
  end if;

  select count(*) into v_active from public.infrastructure_server_enrollments
    where user_id = p_user_id
      and ((phase = 'issued' and expires_at > v_now) or (phase = 'reported' and confirm_by > v_now));
  if v_active >= 3 then return jsonb_build_object('outcome', 'active_limit'); end if;
  select count(*) into v_recent from public.infrastructure_server_enrollments
    where user_id = p_user_id and issued_at > v_now - interval '24 hours';
  if v_recent >= 30 then return jsonb_build_object('outcome', 'daily_limit'); end if;

  insert into public.infrastructure_server_enrollments (
    user_id, code_sha256, phase, issued_at, expires_at, script_version,
    admin_public_key, admin_key_fingerprint, sealed_admin_private_key, created_at, updated_at
  ) values (
    p_user_id, p_code_sha256, 'issued', v_now, v_now + interval '15 minutes', p_script_version,
    p_admin_public_key, p_admin_key_fingerprint, p_sealed_admin_private_key, v_now, v_now
  ) returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'issued', 'owner');
  return jsonb_build_object('outcome', 'issued', 'enrollmentId', v_row.id,
    'issuedAt', v_row.issued_at, 'expiresAt', v_row.expires_at);
end;
$$;

-- A script download with a usable code. Fetching never spends the code, so
-- "view first" and --dry-run keep it valid. After 20 downloads the route
-- serves the fetch-limit refusal and records nothing more.
create or replace function public.record_server_enrollment_fetch(p_code_sha256 text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  if p_code_sha256 is null or p_code_sha256 !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('status', 'not_usable');
  end if;
  select * into v_row from public.infrastructure_server_enrollments
    where code_sha256 = p_code_sha256 for update;
  if not found or v_row.phase <> 'issued' or v_row.expires_at <= v_now then
    return jsonb_build_object('status', 'not_usable');
  end if;
  if v_row.script_fetches >= 20 then
    return jsonb_build_object('status', 'fetch_limit');
  end if;
  update public.infrastructure_server_enrollments
    set script_fetches = script_fetches + 1, last_fetched_at = v_now, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'script_served', 'server');
  return jsonb_build_object('status', 'served', 'userId', v_row.user_id,
    'adminPublicKey', v_row.admin_public_key, 'scriptVersion', v_row.script_version);
end;
$$;

-- One refused report (422 or 400) against a usable code. It does not spend
-- the code; the tenth one cancels it.
create or replace function public.refuse_server_enrollment_report(p_code_sha256 text, p_refusal text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  if p_refusal not in ('private_address', 'ipv4_required', 'invalid_report') then
    raise exception 'Invalid refusal class' using errcode = '22023';
  end if;
  select * into v_row from public.infrastructure_server_enrollments
    where code_sha256 = p_code_sha256 for update;
  if not found or v_row.phase <> 'issued' or v_row.expires_at <= v_now then
    return jsonb_build_object('status', 'not_usable');
  end if;
  update public.infrastructure_server_enrollments
    set refused_reports = refused_reports + 1, last_refusal = p_refusal,
        last_refused_at = v_now, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'refused_report', 'server', p_refusal);
  if v_row.refused_reports >= 10 then
    update public.infrastructure_server_enrollments
      set phase = 'cancelled', decided_at = v_now, sealed_admin_private_key = null, updated_at = v_now
      where id = v_row.id returning * into v_row;
    perform public.append_server_enrollment_event(v_row, 'cancelled', 'hivra', 'refused_report_limit');
    return jsonb_build_object('status', 'refused', 'cancelled', true);
  end if;
  return jsonb_build_object('status', 'refused', 'cancelled', false);
end;
$$;

-- The one accepted report that spends a code. A byte-identical repeat (same
-- digest) gets the stored acknowledgement and changes nothing; the words
-- the app chose for a repeat are discarded.
create or replace function public.report_server_enrollment(
  p_code_sha256 text,
  p_report_digest text,
  p_kind text,
  p_admin_key_fingerprint text,
  p_host_public_key text,
  p_host_fingerprint text,
  p_ssh_port integer,
  p_facts jsonb,
  p_consent text,
  p_reenrollment boolean,
  p_observed_address text,
  p_words text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  if p_report_digest is null or p_report_digest !~ '^[0-9a-f]{64}$'
    or p_kind not in ('enrolled', 'unsupported') then
    raise exception 'Invalid server enrollment report' using errcode = '22023';
  end if;
  select * into v_row from public.infrastructure_server_enrollments
    where code_sha256 = p_code_sha256 for update;
  if not found then return jsonb_build_object('status', 'not_usable'); end if;
  if v_row.phase in ('reported', 'unsupported', 'confirmed', 'rejected')
    and v_row.report_digest = p_report_digest then
    -- A byte-identical repeat is acknowledged while the owner can still
    -- answer, and also after Yes (or Replace) inside the same window: the
    -- server may be retrying a lost acknowledgement while the owner said Yes,
    -- and refusing it would make the server undo the setup Hivra just
    -- connected. After No, cancellation or expiry a repeat is refused, so a
    -- retrying server rolls back. Nothing changes either way.
    if v_row.phase in ('reported', 'confirmed') and v_row.confirm_by > v_now then
      return jsonb_build_object('status', 'accepted', 'enrollmentId', v_row.id,
        'words', v_row.words, 'hostFingerprint', v_row.host_fingerprint_sha256, 'replay', true);
    elsif v_row.phase = 'unsupported' then
      return jsonb_build_object('status', 'unsupported', 'enrollmentId', v_row.id, 'replay', true);
    end if;
    return jsonb_build_object('status', 'not_usable');
  end if;
  if v_row.phase <> 'issued' or v_row.expires_at <= v_now then
    return jsonb_build_object('status', 'not_usable');
  end if;
  if p_consent not in ('terminal', 'no_terminal') or p_facts is null
    or jsonb_typeof(p_facts) <> 'object' or octet_length(p_facts::text) > 2048
    or (p_observed_address is not null and char_length(p_observed_address) not between 2 and 45) then
    raise exception 'Invalid server enrollment report' using errcode = '22023';
  end if;
  if p_kind = 'unsupported' then
    update public.infrastructure_server_enrollments
      set phase = 'unsupported', report_kind = 'unsupported', reported_at = v_now,
          report_digest = p_report_digest, facts = p_facts, consent = p_consent,
          reenrollment = false, observed_address = p_observed_address, decided_at = v_now,
          sealed_admin_private_key = null, updated_at = v_now
      where id = v_row.id returning * into v_row;
    perform public.append_server_enrollment_event(v_row, 'unsupported', 'server');
    return jsonb_build_object('status', 'unsupported', 'enrollmentId', v_row.id);
  end if;
  if p_admin_key_fingerprint is distinct from v_row.admin_key_fingerprint
    or public.is_valid_first_boot_host_key(p_host_public_key, p_host_fingerprint) is not true
    or p_ssh_port is null or p_ssh_port not between 1 and 65535
    or p_reenrollment is null
    or public.is_server_enrollment_words(p_words) is not true then
    raise exception 'Invalid server enrollment report' using errcode = '22023';
  end if;
  update public.infrastructure_server_enrollments
    set phase = 'reported', report_kind = 'enrolled', reported_at = v_now,
        confirm_by = v_now + interval '30 minutes', report_digest = p_report_digest,
        observed_address = p_observed_address, ssh_port = p_ssh_port,
        host_public_key = p_host_public_key, host_fingerprint_sha256 = p_host_fingerprint,
        facts = p_facts, consent = p_consent, reenrollment = p_reenrollment, words = p_words,
        updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'reported', 'server');
  return jsonb_build_object('status', 'accepted', 'enrollmentId', v_row.id,
    'words', v_row.words, 'hostFingerprint', v_row.host_fingerprint_sha256, 'replay', false);
end;
$$;

-- Yes, this is my server. Owner-bound; the app has already re-sealed the
-- enrollment's key in the connection-secret format. Refused for an identity
-- this account already pins: that case is Replace, never Yes.
create or replace function public.confirm_server_enrollment(
  p_user_id text,
  p_enrollment_id uuid,
  p_ssh_host text,
  p_connection_name text,
  p_encrypted_bundle text,
  p_key_version smallint
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
  v_connection public.infrastructure_connections%rowtype;
  v_name text;
  v_suffix integer := 2;
  v_constraint text;
begin
  if p_ssh_host is null or btrim(p_ssh_host) = '' or char_length(p_ssh_host) > 253
    or p_connection_name is null or btrim(p_connection_name) = '' or char_length(p_connection_name) > 80
    or p_encrypted_bundle is null or octet_length(p_encrypted_bundle) not between 32 and 131072 then
    raise exception 'Invalid confirmation' using errcode = '22023';
  end if;
  -- One Yes at a time per account, so two reports of the same identity can
  -- never both become connections.
  perform pg_advisory_xact_lock(hashtextextended('hivra-server-enrollment:' || p_user_id, 0));
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_row.phase <> 'reported' or v_row.confirm_by <= v_now then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  if exists (select 1 from public.server_enrollment_identity_matches(p_user_id, v_row.host_public_key)) then
    return jsonb_build_object('outcome', 'known_identity');
  end if;

  -- Names are unique per account, ignoring case. The advisory lock orders
  -- only other Yes answers: a connection made another way (the SSH details
  -- wizard) can take the chosen name between the check and the insert, so a
  -- clash on the name index moves to the next suffix instead of failing Yes.
  v_name := left(btrim(p_connection_name), 80);
  loop
    while exists (select 1 from public.infrastructure_connections
        where user_id = p_user_id and lower(name) = lower(v_name)) loop
      v_name := left(btrim(p_connection_name), 74) || ' ' || v_suffix;
      v_suffix := v_suffix + 1;
      if v_suffix > 1000 then raise exception 'No free connection name' using errcode = '23505'; end if;
    end loop;
    begin
      insert into public.infrastructure_connections (
        user_id, name, provider, operating_mode, setup_mode, status, ssh_host, ssh_port,
        ssh_user, ssh_host_fingerprint_sha256, ssh_privilege, ssh_host_key_type, config
      ) values (
        p_user_id, v_name, 'host', 'self-managed', 'simple', 'pending', btrim(p_ssh_host), v_row.ssh_port,
        'hivra', public.server_enrollment_key_hex_fingerprint(v_row.host_public_key), 'sudo',
        'ssh-ed25519', '{}'::jsonb
      ) returning * into v_connection;
      exit;
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'infrastructure_connections_user_name_key' then raise; end if;
      v_name := left(btrim(p_connection_name), 74) || ' ' || v_suffix;
      v_suffix := v_suffix + 1;
      if v_suffix > 1000 then raise exception 'No free connection name' using errcode = '23505'; end if;
    end;
  end loop;
  insert into public.infrastructure_connection_secrets (connection_id, user_id, encrypted_bundle, key_version)
    values (v_connection.id, p_user_id, p_encrypted_bundle, p_key_version);

  update public.infrastructure_server_enrollments
    set phase = 'confirmed', outcome = 'connected', connection_id = v_connection.id,
        decided_at = v_now, sealed_admin_private_key = null, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'confirmed', 'owner');
  perform public.append_server_enrollment_event(v_row, 'connection_created', 'owner');
  return jsonb_build_object('outcome', 'connected', 'connectionId', v_connection.id);
end;
$$;

-- Replace access, step 2: a short verification lease. The connection is not
-- changed. p_mode 'key' keeps address, user, privilege and identity (like
-- credential recovery); 'switch' moves a login connection nobody's agents
-- use to the hivra user.
create or replace function public.begin_server_enrollment_replacement(
  p_user_id text,
  p_enrollment_id uuid,
  p_connection_id uuid,
  p_expected_revision bigint,
  p_mode text,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
  v_connection public.infrastructure_connections%rowtype;
  v_matches integer;
begin
  if p_mode not in ('key', 'switch') or p_run_id is null then
    raise exception 'Invalid replacement' using errcode = '22023';
  end if;
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_row.phase <> 'reported' or v_row.confirm_by <= v_now then
    return jsonb_build_object('outcome', 'not_pending');
  end if;
  if v_row.replacement_lease_expires_at is not null and v_row.replacement_lease_expires_at > v_now then
    return jsonb_build_object('outcome', 'busy');
  end if;
  if v_row.replacement_attempts >= 5 then
    return jsonb_build_object('outcome', 'attempts_exhausted');
  end if;
  select * into v_connection from public.infrastructure_connections
    where id = p_connection_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'connection_changed'); end if;
  select count(*) into v_matches from public.server_enrollment_identity_matches(p_user_id, v_row.host_public_key);
  if v_connection.revision <> p_expected_revision or v_connection.provider <> 'host'
    or v_matches <> 1
    or v_connection.ssh_host_fingerprint_sha256
      is distinct from public.server_enrollment_key_hex_fingerprint(v_row.host_public_key)
    or v_connection.preflight_run_id is not null then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;
  if p_mode = 'key' then
    if v_connection.ssh_user <> 'hivra' or v_connection.ssh_privilege <> 'sudo' then
      return jsonb_build_object('outcome', 'connection_changed');
    end if;
    if exists (select 1 from public.hivra_agents
        where infrastructure_connection_id = p_connection_id and user_id = p_user_id
          and operation_id is not null and status <> 'deleted'
          and (operation_started_at is null or operation_started_at > now() - interval '10 minutes')) then
      return jsonb_build_object('outcome', 'operation_running');
    end if;
  else
    if v_connection.ssh_user = 'hivra' and v_connection.ssh_privilege = 'sudo' then
      return jsonb_build_object('outcome', 'connection_changed');
    end if;
    if exists (select 1 from public.hivra_agents
        where infrastructure_connection_id = p_connection_id and user_id = p_user_id
          and deployment_mode = 'self-managed' and status <> 'deleted') then
      return jsonb_build_object('outcome', 'agents_bound');
    end if;
  end if;
  update public.infrastructure_server_enrollments
    set replacement_run_id = p_run_id, replacement_lease_expires_at = v_now + interval '2 minutes',
        replacement_connection_id = p_connection_id, replacement_expected_revision = p_expected_revision,
        replacement_mode = p_mode, replacement_attempts = replacement_attempts + 1, updated_at = v_now
    where id = v_row.id;
  return jsonb_build_object('outcome', 'begun', 'attempt', v_row.replacement_attempts + 1);
end;
$$;

-- Replace access, step 4: the verification sign-in worked. Change the
-- connection the way today's functions do, under the expected revision.
create or replace function public.complete_server_enrollment_replacement(
  p_user_id text,
  p_enrollment_id uuid,
  p_run_id uuid,
  p_encrypted_bundle text,
  p_key_version smallint,
  p_ssh_host text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
  v_connection public.infrastructure_connections%rowtype;
  v_updated public.infrastructure_connections%rowtype;
  v_patch jsonb;
begin
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_row.phase <> 'reported' or v_row.confirm_by <= v_now
    or v_row.replacement_run_id is distinct from p_run_id
    or v_row.replacement_lease_expires_at is null or v_row.replacement_lease_expires_at <= v_now then
    return jsonb_build_object('outcome', 'lease_lost');
  end if;
  select * into v_connection from public.infrastructure_connections
    where id = v_row.replacement_connection_id and user_id = p_user_id for update;
  if not found or v_connection.revision <> v_row.replacement_expected_revision
    or v_connection.ssh_host_fingerprint_sha256
      is distinct from public.server_enrollment_key_hex_fingerprint(v_row.host_public_key)
    or v_connection.preflight_run_id is not null then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;
  if v_row.replacement_mode = 'key' then
    if p_ssh_host is not null then
      raise exception 'A key-only replacement keeps the address' using errcode = '22023';
    end if;
    select * into v_updated from public.recover_infrastructure_connection_credentials(
      p_user_id, v_connection.id, v_row.replacement_expected_revision, p_encrypted_bundle, p_key_version);
  else
    v_patch := jsonb_build_object('ssh_user', 'hivra', 'ssh_privilege', 'sudo',
      'ssh_host_key_type', 'ssh-ed25519');
    if p_ssh_host is not null then
      if btrim(p_ssh_host) = '' or char_length(p_ssh_host) > 253 then
        raise exception 'Invalid address' using errcode = '22023';
      end if;
      v_patch := v_patch || jsonb_build_object('ssh_host', btrim(p_ssh_host));
    end if;
    select * into v_updated from public.update_infrastructure_connection(
      p_user_id, v_connection.id, v_row.replacement_expected_revision, v_patch, true, true,
      p_encrypted_bundle, p_key_version);
  end if;
  if v_updated.id is null then
    return jsonb_build_object('outcome', 'connection_changed');
  end if;

  update public.infrastructure_server_enrollments
    set phase = 'confirmed', outcome = 'replaced_access', connection_id = v_connection.id,
        replaced_from_revision = v_row.replacement_expected_revision, decided_at = v_now,
        sealed_admin_private_key = null, replacement_run_id = null,
        replacement_lease_expires_at = null, last_replacement_failure = null, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'replacement_verified', 'hivra');
  perform public.append_server_enrollment_event(v_row, 'confirmed', 'owner');
  perform public.append_server_enrollment_event(v_row, 'access_replaced', 'owner', v_row.replacement_mode);
  return jsonb_build_object('outcome', 'replaced', 'connectionId', v_connection.id,
    'revision', v_updated.revision);
end;
$$;

-- Replace access, step 5: the verification sign-in failed. The connection,
-- its secret, revision and targets are untouched. The enrollment stays
-- reported until confirm_by, so the owner can try again or choose No.
create or replace function public.fail_server_enrollment_replacement(
  p_user_id text,
  p_enrollment_id uuid,
  p_run_id uuid,
  p_failure text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  if p_failure not in ('host_key_mismatch', 'connection_failed', 'authentication_failed',
      'sudo_unavailable', 'not_root', 'connection_changed', 'proxmox_needs_root') then
    raise exception 'Invalid replacement failure' using errcode = '22023';
  end if;
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found or v_row.replacement_run_id is distinct from p_run_id then
    return jsonb_build_object('outcome', 'lease_lost');
  end if;
  if v_row.phase = 'reported' then
    update public.infrastructure_server_enrollments
      set replacement_run_id = null, replacement_lease_expires_at = null,
          last_replacement_failure = p_failure, updated_at = v_now
      where id = v_row.id returning * into v_row;
  end if;
  perform public.append_server_enrollment_event(v_row, 'replacement_refused', 'hivra', p_failure);
  if p_failure = 'host_key_mismatch' and not exists (
      select 1 from public.infrastructure_server_enrollment_events
      where enrollment_id = v_row.id and kind = 'identity_mismatch') then
    perform public.append_server_enrollment_event(v_row, 'identity_mismatch', 'hivra');
  end if;
  return jsonb_build_object('outcome', 'recorded');
end;
$$;

-- The first sign-in after Yes met a different host key. Recorded once, on
-- the enrollment that created the connection; later mismatches belong to
-- the connection.
create or replace function public.record_server_enrollment_identity_mismatch(
  p_user_id text,
  p_connection_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  select * into v_row from public.infrastructure_server_enrollments
    where user_id = p_user_id and connection_id = p_connection_id and phase = 'confirmed'
    order by decided_at desc limit 1;
  if not found then return false; end if;
  if exists (select 1 from public.infrastructure_server_enrollment_events
      where enrollment_id = v_row.id and kind = 'identity_mismatch')
    or exists (select 1 from public.infrastructure_host_discovery_snapshots
      where connection_id = p_connection_id and user_id = p_user_id) then
    return false;
  end if;
  perform public.append_server_enrollment_event(v_row, 'identity_mismatch', 'hivra');
  return true;
end;
$$;

-- No, cancel. Hivra deletes its key for that server.
create or replace function public.decline_server_enrollment(p_user_id text, p_enrollment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_row.phase <> 'reported' then return jsonb_build_object('outcome', 'not_pending'); end if;
  update public.infrastructure_server_enrollments
    set phase = 'rejected', decided_at = v_now, sealed_admin_private_key = null,
        replacement_run_id = null, replacement_lease_expires_at = null, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'rejected', 'owner');
  return jsonb_build_object('outcome', 'rejected');
end;
$$;

create or replace function public.cancel_server_enrollment(p_user_id text, p_enrollment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.infrastructure_server_enrollments%rowtype;
begin
  select * into v_row from public.infrastructure_server_enrollments
    where id = p_enrollment_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_row.phase not in ('issued', 'reported') then return jsonb_build_object('outcome', 'not_pending'); end if;
  update public.infrastructure_server_enrollments
    set phase = 'cancelled', decided_at = v_now, sealed_admin_private_key = null,
        replacement_run_id = null, replacement_lease_expires_at = null, updated_at = v_now
    where id = v_row.id returning * into v_row;
  perform public.append_server_enrollment_event(v_row, 'cancelled', 'owner');
  return jsonb_build_object('outcome', 'cancelled');
end;
$$;

-- Daily sweep: mark expiry, wipe keys, note removed connections, and delete
-- rows past retention (their receipts go by cascade). Rows that back an
-- existing connection are never deleted. p_now may not run ahead of the
-- database clock, so a caller can never delete early.
create or replace function public.sweep_server_enrollments(p_now timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.infrastructure_server_enrollments%rowtype;
  v_expired integer := 0;
  v_removed integer := 0;
  v_deleted integer := 0;
begin
  if p_now is null or p_now > clock_timestamp() + interval '1 minute' then
    raise exception 'Invalid sweep time' using errcode = '22023';
  end if;
  for v_row in select * from public.infrastructure_server_enrollments
      where (phase = 'issued' and expires_at <= p_now) or (phase = 'reported' and confirm_by <= p_now)
      for update skip locked loop
    update public.infrastructure_server_enrollments
      set phase = 'expired',
          decided_at = case when v_row.phase = 'issued' then v_row.expires_at else v_row.confirm_by end,
          sealed_admin_private_key = null, replacement_run_id = null,
          replacement_lease_expires_at = null, updated_at = clock_timestamp()
      where id = v_row.id returning * into v_row;
    perform public.append_server_enrollment_event(v_row, 'expired', 'hivra');
    v_expired := v_expired + 1;
  end loop;
  update public.infrastructure_server_enrollments
    set connection_removed_at = p_now, updated_at = clock_timestamp()
    where phase = 'confirmed' and connection_id is null and connection_removed_at is null;
  get diagnostics v_removed = row_count;
  delete from public.infrastructure_server_enrollments
    where (phase in ('unsupported', 'rejected', 'cancelled', 'expired')
        and coalesce(decided_at, expires_at) < p_now - interval '30 days')
      or (phase = 'confirmed' and connection_id is null
        and connection_removed_at < p_now - interval '90 days');
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('expired', v_expired, 'connectionsRemoved', v_removed, 'deleted', v_deleted);
end;
$$;

do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.server_enrollment_word_list()',
    'public.is_server_enrollment_words(text)',
    'public.server_enrollment_key_hex_fingerprint(text)',
    'public.append_server_enrollment_event(public.infrastructure_server_enrollments, text, text, text)',
    'public.server_enrollment_identity_matches(text, text)',
    'public.issue_server_enrollment(text, text, text, text, text, text, uuid)',
    'public.record_server_enrollment_fetch(text)',
    'public.refuse_server_enrollment_report(text, text)',
    'public.report_server_enrollment(text, text, text, text, text, text, integer, jsonb, text, boolean, text, text)',
    'public.confirm_server_enrollment(text, uuid, text, text, text, smallint)',
    'public.begin_server_enrollment_replacement(text, uuid, uuid, bigint, text, uuid)',
    'public.complete_server_enrollment_replacement(text, uuid, uuid, text, smallint, text)',
    'public.fail_server_enrollment_replacement(text, uuid, uuid, text)',
    'public.record_server_enrollment_identity_mismatch(text, uuid)',
    'public.decline_server_enrollment(text, uuid)',
    'public.cancel_server_enrollment(text, uuid)',
    'public.sweep_server_enrollments(timestamptz)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', v_signature);
  end loop;
  -- Internal helpers: nobody calls them directly.
  execute 'revoke all on function public.append_server_enrollment_event(public.infrastructure_server_enrollments, text, text, text) from service_role';
  execute 'revoke all on function public.server_enrollment_identity_matches(text, text) from service_role';
  foreach v_signature in array array[
    'public.issue_server_enrollment(text, text, text, text, text, text, uuid)',
    'public.record_server_enrollment_fetch(text)',
    'public.refuse_server_enrollment_report(text, text)',
    'public.report_server_enrollment(text, text, text, text, text, text, integer, jsonb, text, boolean, text, text)',
    'public.confirm_server_enrollment(text, uuid, text, text, text, smallint)',
    'public.begin_server_enrollment_replacement(text, uuid, uuid, bigint, text, uuid)',
    'public.complete_server_enrollment_replacement(text, uuid, uuid, text, smallint, text)',
    'public.fail_server_enrollment_replacement(text, uuid, uuid, text)',
    'public.record_server_enrollment_identity_mismatch(text, uuid)',
    'public.decline_server_enrollment(text, uuid)',
    'public.cancel_server_enrollment(text, uuid)',
    'public.sweep_server_enrollments(timestamptz)'
  ] loop
    execute format('grant execute on function %s to service_role', v_signature);
  end loop;
end;
$$;

comment on table public.infrastructure_server_enrollments is
  'One-command server enrollment codes (sha256 only), their single accepted report and the owner''s answer. A report grants nothing: only Yes, or a verified Replace, creates or changes a connection.';
comment on table public.infrastructure_server_enrollment_events is
  'Append-only receipts for server enrollments. Never updated; deleted only by the cascade from their enrollment.';
