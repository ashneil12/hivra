-- Agent network, package B1: organizations, members, agent principals, policy
-- revisions, brain grants, agent-to-agent edges, an append-only audit log and
-- the card signing key registry.
--
-- Design: docs/superpowers/specs/2026-10-07-shared-brain-and-agent-network.md
-- (sections 6.1, 6.2 and 8, work package B1). Decisions D1 (own tables keyed to
-- the sign-in user ids) and D6 (one organization per agent in v1) are applied
-- as recommended there.
--
-- This is schema and policy only. Nothing reads these objects until the
-- application code that uses them runs, and that code is off on every
-- deployment that is not Canary. No existing table, column, trigger or
-- function is changed, so existing rows and running code are unaffected. A
-- personal account gets its "organization of one" lazily, the first time
-- something asks for it (hivra_net_ensure_personal_org); no backfill runs.
--
-- What the model enforces here
--   * Tenancy. Every row carries org_id and is addressed by (org_id, id), so an
--     id can be reused in another organization without ever being confused with
--     the first, and a foreign key can never cross organizations.
--   * Default deny. A new organization has the network off and no grants or
--     edges. Revision 1 is the empty policy.
--   * Immutable, monotonic policy history. A policy revision is a header row
--     (organization, revision number, author, reason). Settings, groups, group
--     members, grants and edges are rows valid over a range of revisions
--     [valid_from_revision, valid_to_revision). The only change a policy row
--     ever sees is its valid_to_revision being set once. The state at revision R
--     is every row with valid_from <= R and (valid_to is null or R < valid_to).
--   * Attenuation only. A grant or edge has a layer: 'ceiling' (set by an
--     organization owner or admin) or 'narrow' (set by the owner of the agent).
--     A narrow row can only restrict; the publish function rejects one that
--     exceeds the ceiling and rejects a member who changes anything but narrow
--     rows for their own agents.
--   * Live membership. Principal state and membership are rows that change
--     immediately; hivra_net_authz_context reads them live on every call.
--   * Append-only audit. hivra_network_audit has no INSERT, UPDATE or DELETE
--     grant for any role. Entries arrive only through
--     hivra_net_append_audit (service role), form a per-organization hash chain
--     and are never rewritten. Only hivra_net_erase_org (account/organization
--     erasure) removes them.
--   * No agent private key. A principal stores a public key and nothing that
--     could hold a private one. The card signing registry holds public keys
--     only; the private signing key is deployment configuration of a key class
--     that is separate from ENCRYPTION_KEY.
--
-- Access: service role only. Row level security is on with no policy, every API
-- role is revoked, and the service role may SELECT the policy tables but write
-- them only through the functions below.
--
-- Class: additive (new objects only). Safe with the previous deployment running.

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Helpers (pure)
-- ---------------------------------------------------------------------------

create or replace function public.hivra_net_mode_rank(p_mode text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_mode when 'none' then 0 when 'read' then 1 when 'write' then 2 end
$$;

create or replace function public.hivra_net_edge_rank(p_mode text)
returns integer
language sql
immutable
set search_path = pg_catalog
as $$
  select case p_mode when 'deny' then 0 when 'approve' then 1 when 'auto' then 2 end
$$;

-- ---------------------------------------------------------------------------
-- Organizations and members
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_orgs (
  id uuid primary key default gen_random_uuid(),
  -- personal: the "organization of one" every account has, created on demand.
  -- team: several members; created through hivra_net_create_org.
  kind text not null check (kind in ('personal', 'team')),
  name text not null check (length(btrim(name)) between 1 and 256),
  -- The sign-in user id the personal organization belongs to; null for a team.
  personal_owner_user_id text check (
    personal_owner_user_id is null or length(personal_owner_user_id) between 1 and 256
  ),
  -- The newest published policy revision. Written only by the publish function.
  current_revision bigint not null default 0 check (current_revision >= 0),
  created_at timestamptz not null default clock_timestamp(),
  check ((kind = 'personal') = (personal_owner_user_id is not null))
);

comment on table public.hivra_orgs is
  'Agent-network policy domain. A personal account is an organization of one, created on demand. Service role only.';

create unique index if not exists hivra_orgs_one_personal_per_user
  on public.hivra_orgs (personal_owner_user_id)
  where kind = 'personal';

create table if not exists public.hivra_org_members (
  org_id uuid not null references public.hivra_orgs (id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 256),
  role text not null check (role in ('owner', 'admin', 'member')),
  added_at timestamptz not null default clock_timestamp(),
  -- Soft removal keeps history; membership checks read removed_at is null.
  removed_at timestamptz,
  primary key (org_id, user_id)
);

comment on table public.hivra_org_members is
  'Organization members by sign-in user id. Owner and admin set the policy ceiling; a member can only narrow it for their own agents.';

create index if not exists hivra_org_members_user_idx
  on public.hivra_org_members (user_id)
  where removed_at is null;

-- ---------------------------------------------------------------------------
-- Policy revisions (immutable, monotonic)
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_policy_revisions (
  org_id uuid not null references public.hivra_orgs (id) on delete cascade,
  revision bigint not null check (revision >= 1),
  author_user_id text not null check (length(author_user_id) between 1 and 256),
  reason text check (reason is null or length(reason) <= 500),
  created_at timestamptz not null default clock_timestamp(),
  primary key (org_id, revision)
);

comment on table public.hivra_policy_revisions is
  'Immutable, gap-free policy revision headers per organization. The policy at revision R is the set of policy rows valid at R.';

-- ---------------------------------------------------------------------------
-- Principals: one per agent instance, with a state machine
-- ---------------------------------------------------------------------------

-- The canonical agent identity registry is created by 20260904100000. A
-- principal references (id, user_id) of an identity so that the principal's
-- owner is the identity's owner.
create table if not exists public.hivra_principals (
  id uuid not null default gen_random_uuid(),
  org_id uuid not null references public.hivra_orgs (id) on delete cascade,
  agent_identity_id uuid not null,
  owner_user_id text not null check (length(owner_user_id) between 1 and 256),
  state text not null default 'pending' check (state in ('pending', 'joined', 'suspended', 'left')),
  -- Ed25519 public key (raw 32 bytes, base64url). Hivra never holds the private
  -- key; the agent link generates it on the agent computer.
  public_key text check (public_key is null or public_key ~ '^[A-Za-z0-9_-]{43}$'),
  key_version integer not null default 0 check (key_version >= 0),
  key_registered_at timestamptz,
  state_reason text check (state_reason is null or length(state_reason) <= 500),
  joined_at timestamptz,
  suspended_at timestamptz,
  left_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (org_id, id),
  foreign key (org_id, owner_user_id)
    references public.hivra_org_members (org_id, user_id),
  foreign key (agent_identity_id, owner_user_id)
    references public.hivra_canonical_agent_identities (id, user_id)
    on update restrict on delete restrict,
  check ((public_key is null) = (key_registered_at is null)),
  check (state in ('pending', 'left') or public_key is not null)
);

comment on table public.hivra_principals is
  'One agent instance in one organization. State: pending, joined, suspended, left. Public key only; the private key never leaves the agent computer.';

-- D6: one organization per agent in v1. A principal that has left no longer
-- holds the agent.
create unique index if not exists hivra_principals_one_live_org_per_agent
  on public.hivra_principals (agent_identity_id)
  where state <> 'left';

-- A public key identifies one agent. Re-registering a principal's own key is fine.
create unique index if not exists hivra_principals_one_live_key
  on public.hivra_principals (public_key)
  where public_key is not null and state <> 'left';

create index if not exists hivra_principals_owner_idx
  on public.hivra_principals (org_id, owner_user_id);

-- ---------------------------------------------------------------------------
-- Policy rows, valid over a range of revisions
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_org_settings (
  org_id uuid not null,
  valid_from_revision bigint not null,
  valid_to_revision bigint,
  network_enabled boolean not null default false,
  paused boolean not null default false,
  -- D5: Buzz is forbidden by default once the network is on.
  buzz_binding_default text not null default 'forbidden' check (buzz_binding_default in ('allowed', 'forbidden')),
  max_hop_depth integer not null default 3 check (max_hop_depth between 1 and 8),
  primary key (org_id, valid_from_revision),
  foreign key (org_id, valid_from_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  foreign key (org_id, valid_to_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  check (valid_to_revision is null or valid_to_revision > valid_from_revision)
);

create unique index if not exists hivra_org_settings_one_active
  on public.hivra_org_settings (org_id) where valid_to_revision is null;

create table if not exists public.hivra_org_groups (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 128),
  valid_from_revision bigint not null,
  valid_to_revision bigint,
  primary key (org_id, id),
  foreign key (org_id, valid_from_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  foreign key (org_id, valid_to_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  check (valid_to_revision is null or valid_to_revision > valid_from_revision)
);

create table if not exists public.hivra_org_group_members (
  org_id uuid not null,
  group_id uuid not null,
  principal_id uuid not null,
  valid_from_revision bigint not null,
  valid_to_revision bigint,
  primary key (org_id, group_id, principal_id, valid_from_revision),
  foreign key (org_id, group_id) references public.hivra_org_groups (org_id, id) on delete cascade,
  foreign key (org_id, principal_id) references public.hivra_principals (org_id, id) on delete cascade,
  foreign key (org_id, valid_from_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  foreign key (org_id, valid_to_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  check (valid_to_revision is null or valid_to_revision > valid_from_revision)
);

create unique index if not exists hivra_org_group_members_one_active
  on public.hivra_org_group_members (org_id, group_id, principal_id) where valid_to_revision is null;

-- Which shared memory an agent may read or write. Sources: 'org', 'team/<group
-- id>' and 'agent/<principal id>'. An agent's own private source is writable by
-- that agent unless a principal ceiling row for it says otherwise; a private
-- source is never granted to another principal.
create table if not exists public.hivra_brain_grants (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  layer text not null check (layer in ('ceiling', 'narrow')),
  principal_id uuid,
  group_id uuid,
  source text not null check (
    source ~ '^(org|team/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|agent/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'
  ),
  mode text not null check (mode in ('none', 'read', 'write')),
  author_user_id text not null check (length(author_user_id) between 1 and 256),
  valid_from_revision bigint not null,
  valid_to_revision bigint,
  primary key (org_id, id),
  foreign key (org_id, principal_id) references public.hivra_principals (org_id, id) on delete cascade,
  foreign key (org_id, group_id) references public.hivra_org_groups (org_id, id) on delete cascade,
  foreign key (org_id, valid_from_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  foreign key (org_id, valid_to_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  check ((principal_id is null) <> (group_id is null)),
  -- Only the agent's owner narrows, and only for that agent.
  check (layer = 'ceiling' or principal_id is not null),
  -- A private source belongs to its agent: only a principal row, and only for itself.
  check (source not like 'agent/%' or (principal_id is not null and source = 'agent/' || principal_id::text)),
  check (valid_to_revision is null or valid_to_revision > valid_from_revision)
);

create unique index if not exists hivra_brain_grants_one_active_principal
  on public.hivra_brain_grants (org_id, layer, principal_id, source)
  where valid_to_revision is null and principal_id is not null;
create unique index if not exists hivra_brain_grants_one_active_group
  on public.hivra_brain_grants (org_id, layer, group_id, source)
  where valid_to_revision is null and group_id is not null;

-- Directed agent-to-agent edges: the sender is from_principal_id. A reply
-- direction is a second edge, which lets the two directions carry different
-- modes and limits. NULL limits mean "no limit set on this row".
create table if not exists public.hivra_agent_edges (
  org_id uuid not null,
  id uuid not null default gen_random_uuid(),
  layer text not null check (layer in ('ceiling', 'narrow')),
  from_principal_id uuid not null,
  to_principal_id uuid not null,
  mode text not null check (mode in ('deny', 'approve', 'auto')),
  max_messages_per_hour integer check (max_messages_per_hour is null or max_messages_per_hour > 0),
  max_concurrent_runs integer check (max_concurrent_runs is null or max_concurrent_runs > 0),
  author_user_id text not null check (length(author_user_id) between 1 and 256),
  valid_from_revision bigint not null,
  valid_to_revision bigint,
  primary key (org_id, id),
  foreign key (org_id, from_principal_id) references public.hivra_principals (org_id, id) on delete cascade,
  foreign key (org_id, to_principal_id) references public.hivra_principals (org_id, id) on delete cascade,
  foreign key (org_id, valid_from_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  foreign key (org_id, valid_to_revision)
    references public.hivra_policy_revisions (org_id, revision) on delete cascade,
  check (from_principal_id <> to_principal_id),
  check (valid_to_revision is null or valid_to_revision > valid_from_revision)
);

create unique index if not exists hivra_agent_edges_one_active
  on public.hivra_agent_edges (org_id, layer, from_principal_id, to_principal_id)
  where valid_to_revision is null;

-- ---------------------------------------------------------------------------
-- Responsibility record (VISION.md: six independent facts, none defaulted)
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_network_responsibilities (
  org_id uuid not null references public.hivra_orgs (id) on delete cascade,
  service text not null check (service in ('brain', 'broker')),
  control_plane_operator text not null check (control_plane_operator in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  -- Includes embedding and LLM keys held by the service.
  credential_custodian text not null check (credential_custodian in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  spend_owner text not null check (spend_owner in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  capacity_operator text not null check (capacity_operator in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  recovery_owner text not null check (recovery_owner in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  support_party text not null check (support_party in ('org', 'hivra_cloud', 'self_hosted_operator', 'third_party')),
  recorded_by text not null check (length(recorded_by) between 1 and 256),
  recorded_at timestamptz not null default clock_timestamp(),
  note text check (note is null or length(note) <= 500),
  primary key (org_id, service)
);

comment on table public.hivra_network_responsibilities is
  'Who operates, holds credentials for, pays for, runs, recovers and supports the brain service and the broker for an organization. Every field is declared; none is defaulted from one operating mode.';

-- ---------------------------------------------------------------------------
-- Card signing key registry (public keys only; separate key class)
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_card_signing_keys (
  kid text primary key check (kid ~ '^[A-Za-z0-9._-]{8,64}$'),
  algorithm text not null default 'EdDSA' check (algorithm = 'EdDSA'),
  public_key text not null unique check (public_key ~ '^[A-Za-z0-9_-]{43}$'),
  -- active: signs and verifies. retired: stopped signing; cards it signed
  -- before retired_at stay valid until they expire. revoked: every card it
  -- signed fails verification immediately (the revocation list).
  status text not null default 'active' check (status in ('active', 'retired', 'revoked')),
  created_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  revoked_at timestamptz,
  revoked_reason text check (revoked_reason is null or length(revoked_reason) <= 500),
  check (
    (status = 'active' and retired_at is null and revoked_at is null)
    or (status = 'retired' and retired_at is not null and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
);

comment on table public.hivra_card_signing_keys is
  'Public half of the keys that sign agent cards, with retirement and the revocation list. The private key is deployment configuration, never stored here and never derived from ENCRYPTION_KEY.';

-- ---------------------------------------------------------------------------
-- Audit log (append-only, per-organization hash chain)
-- ---------------------------------------------------------------------------

create table if not exists public.hivra_network_audit (
  -- No foreign key: the log outlives the objects it describes, and only the
  -- erase function removes it with the organization.
  org_id uuid not null,
  seq bigint not null check (seq >= 1),
  occurred_at timestamptz not null default clock_timestamp(),
  action text not null check (action ~ '^[a-z0-9_.:-]{1,64}$'),
  actor_user_id text check (actor_user_id is null or length(actor_user_id) between 1 and 256),
  actor_principal_id uuid,
  subject_principal_id uuid,
  resource text check (resource is null or length(resource) <= 256),
  decision text not null default 'n/a' check (decision in ('allow', 'deny', 'approve', 'n/a')),
  rule text check (rule is null or length(rule) <= 128),
  reason text check (reason is null or length(reason) <= 500),
  policy_revision bigint check (policy_revision is null or policy_revision >= 0),
  -- A message or request is recorded by digest and size, never by content.
  digest text check (digest is null or digest ~ '^[0-9a-f]{64}$'),
  size_bytes integer check (size_bytes is null or size_bytes >= 0),
  detail jsonb not null default '{}'::jsonb check (jsonb_typeof(detail) = 'object' and length(detail::text) <= 2048),
  prev_hash text not null check (prev_hash ~ '^[0-9a-f]{64}$'),
  entry_hash text not null check (entry_hash ~ '^[0-9a-f]{64}$'),
  primary key (org_id, seq)
);

comment on table public.hivra_network_audit is
  'Append-only, hash-chained audit log per organization. Content-free: principals, rule, policy revision, decision, digest and size. Written only through hivra_net_append_audit.';

-- ---------------------------------------------------------------------------
-- Guards: history is immutable, audit is append-only, state machines
-- ---------------------------------------------------------------------------

-- Policy history may only be erased with its organization, and a policy row may
-- only have its valid_to_revision set, once.
create or replace function public.hivra_net_guard_history()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_erasing text := nullif(current_setting('hivra.net_erase_org', true), '');
begin
  if tg_op = 'DELETE' then
    if v_erasing is not null and v_erasing = old.org_id::text then
      return old;
    end if;
    raise exception 'hivra_net: % is append-only history', tg_table_name using errcode = 'HN405';
  end if;

  if tg_table_name <> 'hivra_policy_revisions'
     and (to_jsonb(old) -> 'valid_to_revision') = 'null'::jsonb
     and (to_jsonb(new) -> 'valid_to_revision') <> 'null'::jsonb
     and (to_jsonb(new) - 'valid_to_revision') = (to_jsonb(old) - 'valid_to_revision') then
    return new;
  end if;
  raise exception 'hivra_net: % is append-only history', tg_table_name using errcode = 'HN405';
end;
$$;

create or replace function public.hivra_net_guard_truncate()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'hivra_net: % cannot be truncated', tg_table_name using errcode = 'HN405';
end;
$$;

create or replace function public.hivra_net_guard_audit()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_erasing text := nullif(current_setting('hivra.net_erase_org', true), '');
begin
  if tg_op = 'DELETE' and v_erasing is not null and v_erasing = old.org_id::text then
    return old;
  end if;
  raise exception 'hivra_net: the audit log is append-only' using errcode = 'HN405';
end;
$$;

create or replace function public.hivra_net_guard_member()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_org record;
begin
  select kind, personal_owner_user_id into v_org from public.hivra_orgs where id = new.org_id;
  if tg_op = 'UPDATE' and (new.org_id <> old.org_id or new.user_id <> old.user_id) then
    raise exception 'hivra_net: a membership cannot move between organizations or users' using errcode = 'HN422';
  end if;
  if v_org.kind = 'personal' then
    if new.user_id <> v_org.personal_owner_user_id or new.role <> 'owner' or new.removed_at is not null then
      raise exception 'hivra_net: a personal organization has exactly one member, its owner' using errcode = 'HN422';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.hivra_net_guard_principal()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.org_id <> old.org_id or new.id <> old.id
       or new.agent_identity_id <> old.agent_identity_id
       or new.owner_user_id <> old.owner_user_id then
      raise exception 'hivra_net: a principal cannot change organization, identity or owner' using errcode = 'HN422';
    end if;
    if new.state <> old.state and not (
         (old.state = 'pending' and new.state in ('joined', 'left'))
      or (old.state = 'joined' and new.state in ('suspended', 'left'))
      or (old.state = 'suspended' and new.state in ('joined', 'left'))
    ) then
      raise exception 'hivra_net: principal state % -> % is not allowed', old.state, new.state using errcode = 'HN409';
    end if;
    if old.state = 'left' and (new.public_key is distinct from old.public_key or new.key_version <> old.key_version) then
      raise exception 'hivra_net: a principal that has left cannot register a key' using errcode = 'HN409';
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create or replace function public.hivra_net_guard_card_key()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'hivra_net: signing keys are never deleted; revoke them' using errcode = 'HN405';
  end if;
  if new.kid <> old.kid or new.public_key <> old.public_key or new.algorithm <> old.algorithm
     or new.created_at <> old.created_at then
    raise exception 'hivra_net: a signing key''s identity is immutable' using errcode = 'HN405';
  end if;
  if new.status <> old.status and not (
       (old.status = 'active' and new.status in ('retired', 'revoked'))
    or (old.status = 'retired' and new.status = 'revoked')
  ) then
    raise exception 'hivra_net: signing key status % -> % is not allowed', old.status, new.status using errcode = 'HN409';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'hivra_policy_revisions', 'hivra_org_settings', 'hivra_org_groups',
    'hivra_org_group_members', 'hivra_brain_grants', 'hivra_agent_edges'
  ] loop
    execute format('drop trigger if exists %I on public.%I', t || '_history_guard', t);
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.hivra_net_guard_history()',
      t || '_history_guard', t);
    execute format('drop trigger if exists %I on public.%I', t || '_truncate_guard', t);
    execute format(
      'create trigger %I before truncate on public.%I for each statement execute function public.hivra_net_guard_truncate()',
      t || '_truncate_guard', t);
  end loop;
end
$$;

drop trigger if exists hivra_network_audit_append_only on public.hivra_network_audit;
create trigger hivra_network_audit_append_only
  before update or delete on public.hivra_network_audit
  for each row execute function public.hivra_net_guard_audit();
drop trigger if exists hivra_network_audit_truncate_guard on public.hivra_network_audit;
create trigger hivra_network_audit_truncate_guard
  before truncate on public.hivra_network_audit
  for each statement execute function public.hivra_net_guard_truncate();

drop trigger if exists hivra_org_members_guard on public.hivra_org_members;
create trigger hivra_org_members_guard
  before insert or update on public.hivra_org_members
  for each row execute function public.hivra_net_guard_member();

drop trigger if exists hivra_principals_guard on public.hivra_principals;
create trigger hivra_principals_guard
  before update on public.hivra_principals
  for each row execute function public.hivra_net_guard_principal();

drop trigger if exists hivra_card_signing_keys_guard on public.hivra_card_signing_keys;
create trigger hivra_card_signing_keys_guard
  before update or delete on public.hivra_card_signing_keys
  for each row execute function public.hivra_net_guard_card_key();

-- ---------------------------------------------------------------------------
-- Audit append (service role). Chain: entry_hash = sha256 of the entry's
-- fields and the previous entry's hash; the first entry follows 64 zeros.
-- ---------------------------------------------------------------------------

create or replace function public.hivra_net_audit_entry_hash(
  p_org_id uuid, p_seq bigint, p_occurred_at timestamptz, p_action text,
  p_actor_user_id text, p_actor_principal_id uuid, p_subject_principal_id uuid,
  p_resource text, p_decision text, p_rule text, p_reason text,
  p_policy_revision bigint, p_digest text, p_size_bytes integer,
  p_detail jsonb, p_prev_hash text
)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select encode(
    sha256(convert_to(
      jsonb_build_array(
        p_org_id, p_seq,
        to_char(p_occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        p_action, p_actor_user_id, p_actor_principal_id, p_subject_principal_id,
        p_resource, p_decision, p_rule, p_reason, p_policy_revision, p_digest,
        p_size_bytes, p_detail, p_prev_hash
      )::text,
      'UTF8')),
    'hex')
$$;

create or replace function public.hivra_net_append_audit(
  p_org_id uuid,
  p_action text,
  p_actor_user_id text default null,
  p_actor_principal_id uuid default null,
  p_subject_principal_id uuid default null,
  p_resource text default null,
  p_decision text default 'n/a',
  p_rule text default null,
  p_reason text default null,
  p_policy_revision bigint default null,
  p_digest text default null,
  p_size_bytes integer default null,
  p_detail jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_prev record;
  v_seq bigint;
  v_prev_hash text;
  v_at timestamptz := clock_timestamp();
  v_hash text;
begin
  if p_org_id is null or not exists (select 1 from public.hivra_orgs where id = p_org_id) then
    raise exception 'hivra_net: audit entry for an unknown organization' using errcode = 'HN404';
  end if;
  -- The log carries no message or request body.
  if p_detail is not null and jsonb_typeof(p_detail) = 'object'
     and p_detail ?| array['body', 'content', 'text', 'message', 'payload', 'prompt', 'secret', 'token', 'key'] then
    raise exception 'hivra_net: audit detail must not carry content or secrets' using errcode = 'HN422';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hivra_network_audit:' || p_org_id::text, 0));
  select seq, entry_hash into v_prev
    from public.hivra_network_audit
   where org_id = p_org_id
   order by seq desc
   limit 1;
  v_seq := coalesce(v_prev.seq, 0) + 1;
  v_prev_hash := coalesce(v_prev.entry_hash, repeat('0', 64));
  v_hash := public.hivra_net_audit_entry_hash(
    p_org_id, v_seq, v_at, p_action, p_actor_user_id, p_actor_principal_id,
    p_subject_principal_id, p_resource, p_decision, p_rule, p_reason,
    p_policy_revision, p_digest, p_size_bytes, coalesce(p_detail, '{}'::jsonb), v_prev_hash);

  insert into public.hivra_network_audit(
    org_id, seq, occurred_at, action, actor_user_id, actor_principal_id,
    subject_principal_id, resource, decision, rule, reason, policy_revision,
    digest, size_bytes, detail, prev_hash, entry_hash
  ) values (
    p_org_id, v_seq, v_at, p_action, p_actor_user_id, p_actor_principal_id,
    p_subject_principal_id, p_resource, p_decision, p_rule, p_reason,
    p_policy_revision, p_digest, p_size_bytes, coalesce(p_detail, '{}'::jsonb),
    v_prev_hash, v_hash);
  return v_seq;
end;
$$;

-- Recomputes the chain. Returns one row: ok, number of entries, and the first
-- sequence number at which a hash, a link or the numbering is wrong.
create or replace function public.hivra_net_verify_audit_chain(p_org_id uuid)
returns table (ok boolean, entries bigint, first_bad_seq bigint, problem text)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  r record;
  v_expected_seq bigint := 1;
  v_prev_hash text := repeat('0', 64);
  v_count bigint := 0;
begin
  for r in
    select * from public.hivra_network_audit a where a.org_id = p_org_id order by a.seq
  loop
    v_count := v_count + 1;
    if r.seq <> v_expected_seq then
      return query select false, v_count, v_expected_seq, 'gap in sequence numbers'::text;
      return;
    end if;
    if r.prev_hash <> v_prev_hash then
      return query select false, v_count, r.seq, 'previous hash does not match'::text;
      return;
    end if;
    if r.entry_hash <> public.hivra_net_audit_entry_hash(
         r.org_id, r.seq, r.occurred_at, r.action, r.actor_user_id, r.actor_principal_id,
         r.subject_principal_id, r.resource, r.decision, r.rule, r.reason,
         r.policy_revision, r.digest, r.size_bytes, r.detail, r.prev_hash) then
      return query select false, v_count, r.seq, 'entry hash does not match its content'::text;
      return;
    end if;
    v_prev_hash := r.entry_hash;
    v_expected_seq := v_expected_seq + 1;
  end loop;
  return query select true, v_count, null::bigint, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- Organizations: creation, "organization of one", membership
-- ---------------------------------------------------------------------------

create or replace function public.hivra_net_create_org(
  p_kind text,
  p_owner_user_id text,
  p_name text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  if p_kind not in ('personal', 'team') then
    raise exception 'hivra_net: unknown organization kind' using errcode = 'HN422';
  end if;
  if p_owner_user_id is null or length(btrim(p_owner_user_id)) = 0 then
    raise exception 'hivra_net: an organization needs an owner' using errcode = 'HN422';
  end if;

  insert into public.hivra_orgs(kind, name, personal_owner_user_id)
  values (p_kind, p_name, case when p_kind = 'personal' then p_owner_user_id end)
  returning id into v_org;

  insert into public.hivra_org_members(org_id, user_id, role) values (v_org, p_owner_user_id, 'owner');

  -- Revision 1 is the empty policy: network off, nothing granted, no edges.
  insert into public.hivra_policy_revisions(org_id, revision, author_user_id, reason)
  values (v_org, 1, p_owner_user_id, 'organization created');
  insert into public.hivra_org_settings(org_id, valid_from_revision) values (v_org, 1);
  update public.hivra_orgs set current_revision = 1 where id = v_org;

  perform public.hivra_net_append_audit(
    v_org, 'org.create', p_owner_user_id, null, null, null, 'n/a', null, null, 1, null, null,
    jsonb_build_object('kind', p_kind));
  return v_org;
end;
$$;

-- Every account is an organization of one. Created on first use, idempotent,
-- and nothing else is touched.
create or replace function public.hivra_net_ensure_personal_org(p_user_id text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  if p_user_id is null or length(btrim(p_user_id)) = 0 then
    raise exception 'hivra_net: a personal organization needs a user id' using errcode = 'HN422';
  end if;
  select id into v_org from public.hivra_orgs where kind = 'personal' and personal_owner_user_id = p_user_id;
  if v_org is not null then
    return v_org;
  end if;
  begin
    return public.hivra_net_create_org('personal', p_user_id, 'Personal');
  exception when unique_violation then
    select id into v_org from public.hivra_orgs where kind = 'personal' and personal_owner_user_id = p_user_id;
    return v_org;
  end;
end;
$$;

create or replace function public.hivra_net_add_member(
  p_org_id uuid, p_user_id text, p_role text, p_actor_user_id text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role text;
begin
  perform 1 from public.hivra_orgs where id = p_org_id for update;
  if not found then
    raise exception 'hivra_net: unknown organization' using errcode = 'HN404';
  end if;
  select role into v_actor_role from public.hivra_org_members
   where org_id = p_org_id and user_id = p_actor_user_id and removed_at is null;
  if v_actor_role is null or v_actor_role = 'member' or (p_role = 'owner' and v_actor_role <> 'owner') then
    raise exception 'hivra_net: not allowed to add this member' using errcode = 'HN403';
  end if;
  insert into public.hivra_org_members(org_id, user_id, role)
  values (p_org_id, p_user_id, p_role)
  on conflict (org_id, user_id) do update set role = excluded.role, removed_at = null, added_at = clock_timestamp();
  perform public.hivra_net_append_audit(
    p_org_id, 'member.add', p_actor_user_id, null, null, null, 'n/a', null, null, null, null, null,
    jsonb_build_object('role', p_role));
end;
$$;

-- Moves a principal along its state machine. Callers hold the organization row
-- lock. 'left' also ends the principal's policy rows in a new revision.
create or replace function public.hivra_net_move_principal(
  p_org_id uuid, p_principal_id uuid, p_to_state text, p_actor text, p_reason text
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_from text;
  v_new bigint;
  v_closed integer := 0;
  v_n integer;
begin
  select state into v_from from public.hivra_principals where org_id = p_org_id and id = p_principal_id for update;
  if v_from is null then
    raise exception 'hivra_net: unknown principal' using errcode = 'HN404';
  end if;
  if v_from = p_to_state then
    raise exception 'hivra_net: the principal is already %', v_from using errcode = 'HN409';
  end if;

  update public.hivra_principals
     set state = p_to_state,
         state_reason = p_reason,
         joined_at = case when p_to_state = 'joined' and joined_at is null then clock_timestamp() else joined_at end,
         suspended_at = case when p_to_state = 'suspended' then clock_timestamp() else suspended_at end,
         left_at = case when p_to_state = 'left' then clock_timestamp() else left_at end
   where org_id = p_org_id and id = p_principal_id;

  if p_to_state = 'left' then
    select current_revision + 1 into v_new from public.hivra_orgs where id = p_org_id;
    -- Count first so a principal with no policy rows does not burn a revision.
    select
      (select count(*) from public.hivra_brain_grants where org_id = p_org_id and valid_to_revision is null and principal_id = p_principal_id)
      + (select count(*) from public.hivra_agent_edges where org_id = p_org_id and valid_to_revision is null
           and (from_principal_id = p_principal_id or to_principal_id = p_principal_id))
      + (select count(*) from public.hivra_org_group_members where org_id = p_org_id and valid_to_revision is null and principal_id = p_principal_id)
      into v_n;
    if v_n > 0 then
      insert into public.hivra_policy_revisions(org_id, revision, author_user_id, reason)
      values (p_org_id, v_new, p_actor, 'principal left: its grants, edges and group memberships end');
      update public.hivra_brain_grants set valid_to_revision = v_new
       where org_id = p_org_id and valid_to_revision is null and principal_id = p_principal_id;
      update public.hivra_agent_edges set valid_to_revision = v_new
       where org_id = p_org_id and valid_to_revision is null
         and (from_principal_id = p_principal_id or to_principal_id = p_principal_id);
      update public.hivra_org_group_members set valid_to_revision = v_new
       where org_id = p_org_id and valid_to_revision is null and principal_id = p_principal_id;
      update public.hivra_orgs set current_revision = v_new where id = p_org_id;
      v_closed := v_n;
    end if;
  end if;

  perform public.hivra_net_append_audit(
    p_org_id, 'principal.' || p_to_state, p_actor, null, p_principal_id, null, 'n/a', null, p_reason,
    (select current_revision from public.hivra_orgs where id = p_org_id), null, null,
    jsonb_build_object('from', v_from, 'to', p_to_state, 'policyRowsEnded', v_closed));
end;
$$;

create or replace function public.hivra_net_remove_member(
  p_org_id uuid, p_user_id text, p_actor_user_id text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor_role text;
  v_target_role text;
  v_changed integer := 0;
  p record;
begin
  perform 1 from public.hivra_orgs where id = p_org_id for update;
  if not found then
    raise exception 'hivra_net: unknown organization' using errcode = 'HN404';
  end if;
  select role into v_actor_role from public.hivra_org_members
   where org_id = p_org_id and user_id = p_actor_user_id and removed_at is null;
  select role into v_target_role from public.hivra_org_members
   where org_id = p_org_id and user_id = p_user_id and removed_at is null;
  if v_target_role is null then
    raise exception 'hivra_net: not an active member' using errcode = 'HN404';
  end if;
  -- A member may leave; removing another member needs owner or admin, and only
  -- an owner removes an owner or admin.
  if p_actor_user_id is distinct from p_user_id then
    if v_actor_role is null or v_actor_role = 'member'
       or (v_target_role in ('owner', 'admin') and v_actor_role <> 'owner') then
      raise exception 'hivra_net: not allowed to remove this member' using errcode = 'HN403';
    end if;
  end if;
  if v_target_role = 'owner'
     and not exists (select 1 from public.hivra_org_members
                      where org_id = p_org_id and role = 'owner' and removed_at is null and user_id <> p_user_id) then
    raise exception 'hivra_net: an organization keeps at least one owner' using errcode = 'HN409';
  end if;

  update public.hivra_org_members set removed_at = clock_timestamp()
   where org_id = p_org_id and user_id = p_user_id;

  -- Their agents stop being reachable at the next request: joined agents are
  -- suspended, agents that never finished joining are dropped.
  for p in
    select id, state from public.hivra_principals
     where org_id = p_org_id and owner_user_id = p_user_id and state in ('pending', 'joined')
  loop
    perform public.hivra_net_move_principal(
      p_org_id, p.id, case p.state when 'pending' then 'left' else 'suspended' end,
      p_actor_user_id, 'member removed');
    v_changed := v_changed + 1;
  end loop;

  perform public.hivra_net_append_audit(
    p_org_id, 'member.remove', p_actor_user_id, null, null, null, 'n/a', null, null, null, null, null,
    jsonb_build_object('principalsAffected', v_changed));
  return v_changed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Principals: begin joining, register the public key, change state
-- ---------------------------------------------------------------------------

-- Joining is an explicit action by the agent's owner (NET-7); launching an
-- agent never calls this. The principal starts pending.
create or replace function public.hivra_net_begin_join(
  p_org_id uuid, p_agent_identity_id uuid, p_owner_user_id text, p_actor_user_id text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_id uuid;
begin
  if p_actor_user_id is distinct from p_owner_user_id then
    raise exception 'hivra_net: only the agent''s owner joins it' using errcode = 'HN403';
  end if;
  perform 1 from public.hivra_org_members
   where org_id = p_org_id and user_id = p_owner_user_id and removed_at is null;
  if not found then
    raise exception 'hivra_net: not a member of this organization' using errcode = 'HN403';
  end if;
  insert into public.hivra_principals(org_id, agent_identity_id, owner_user_id)
  values (p_org_id, p_agent_identity_id, p_owner_user_id)
  returning id into v_id;
  perform public.hivra_net_append_audit(
    p_org_id, 'principal.begin_join', p_actor_user_id, null, v_id, null, 'n/a', null, null, null, null, null, '{}'::jsonb);
  return v_id;
end;
$$;

-- Stores the agent's public key after the caller has verified proof of
-- possession. The only key material accepted is a public key.
create or replace function public.hivra_net_set_principal_key(
  p_org_id uuid, p_principal_id uuid, p_public_key text, p_actor_user_id text
)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_state text;
  v_version integer;
begin
  select owner_user_id, state into v_owner, v_state from public.hivra_principals
   where org_id = p_org_id and id = p_principal_id for update;
  if v_owner is null then
    raise exception 'hivra_net: unknown principal' using errcode = 'HN404';
  end if;
  if v_state = 'left' then
    raise exception 'hivra_net: a principal that has left cannot register a key' using errcode = 'HN409';
  end if;
  if p_actor_user_id is distinct from v_owner
     and not exists (select 1 from public.hivra_org_members
                      where org_id = p_org_id and user_id = p_actor_user_id and removed_at is null
                        and role in ('owner', 'admin')) then
    raise exception 'hivra_net: not allowed to register this key' using errcode = 'HN403';
  end if;
  update public.hivra_principals
     set public_key = p_public_key, key_version = key_version + 1, key_registered_at = clock_timestamp()
   where org_id = p_org_id and id = p_principal_id
   returning key_version into v_version;
  perform public.hivra_net_append_audit(
    p_org_id, 'principal.key', p_actor_user_id, null, p_principal_id, null, 'n/a', null, null, null, null, null,
    jsonb_build_object('keyVersion', v_version));
  return v_version;
end;
$$;

create or replace function public.hivra_net_transition_principal(
  p_org_id uuid, p_principal_id uuid, p_to_state text, p_actor_user_id text, p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_from text;
  v_actor_role text;
  v_is_owner boolean;
begin
  if p_to_state not in ('joined', 'suspended', 'left') then
    raise exception 'hivra_net: a principal cannot be moved to %', p_to_state using errcode = 'HN422';
  end if;
  perform 1 from public.hivra_orgs where id = p_org_id for update;
  if not found then
    raise exception 'hivra_net: unknown organization' using errcode = 'HN404';
  end if;
  select owner_user_id, state into v_owner, v_from from public.hivra_principals
   where org_id = p_org_id and id = p_principal_id;
  if v_owner is null then
    raise exception 'hivra_net: unknown principal' using errcode = 'HN404';
  end if;
  select role into v_actor_role from public.hivra_org_members
   where org_id = p_org_id and user_id = p_actor_user_id and removed_at is null;
  v_is_owner := v_actor_role is not null and p_actor_user_id = v_owner;

  if p_to_state = 'joined' and v_from = 'pending' then
    -- Consent: only the agent's owner finishes joining.
    if not v_is_owner then
      raise exception 'hivra_net: only the agent''s owner finishes joining' using errcode = 'HN403';
    end if;
  elsif p_to_state = 'joined' then
    -- Resuming a suspended principal is an admin decision.
    if v_actor_role is null or v_actor_role not in ('owner', 'admin') then
      raise exception 'hivra_net: only an owner or admin resumes an agent' using errcode = 'HN403';
    end if;
  elsif not (v_is_owner or v_actor_role in ('owner', 'admin')) then
    raise exception 'hivra_net: not allowed to change this agent' using errcode = 'HN403';
  end if;

  perform public.hivra_net_move_principal(p_org_id, p_principal_id, p_to_state, p_actor_user_id, p_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Publish a policy revision (the only way policy rows are written)
-- ---------------------------------------------------------------------------

-- p_document is the complete desired policy:
--   { settings: {network_enabled, paused, buzz_binding_default, max_hop_depth},
--     groups: [{id, name}], group_members: [{group_id, principal_id}],
--     grants: [{layer, principal_id | group_id, source, mode}],
--     edges: [{layer, from_principal_id, to_principal_id, mode,
--              max_messages_per_hour, max_concurrent_runs}] }
-- Every key is required; an omitted list is not "unchanged". The function
-- compares it with the current policy, authorizes the difference by role,
-- rejects any narrowing row that exceeds the ceiling, and writes the next
-- revision. An identical document writes nothing and returns the current
-- revision. A stale p_expected_revision is rejected so two editors cannot
-- overwrite each other.
create or replace function public.hivra_net_publish_policy_revision(
  p_org_id uuid,
  p_expected_revision bigint,
  p_author_user_id text,
  p_reason text,
  p_document jsonb
)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current bigint;
  v_role text;
  v_new bigint;
  v_settings_changed boolean;
  v_n_groups_add integer;
  v_n_groups_del integer;
  v_n_members_add integer;
  v_n_members_del integer;
  v_n_grants_add integer;
  v_n_grants_del integer;
  v_n_edges_add integer;
  v_n_edges_del integer;
  v_bad integer;
  s record;
begin
  select current_revision into v_current from public.hivra_orgs where id = p_org_id for update;
  if v_current is null then
    raise exception 'hivra_net: unknown organization' using errcode = 'HN404';
  end if;
  if p_expected_revision is distinct from v_current then
    raise exception 'hivra_net: the policy changed (expected revision %, current %)', p_expected_revision, v_current
      using errcode = 'HN409';
  end if;
  select role into v_role from public.hivra_org_members
   where org_id = p_org_id and user_id = p_author_user_id and removed_at is null;
  if v_role is null then
    raise exception 'hivra_net: not a member of this organization' using errcode = 'HN403';
  end if;

  if p_document is null or jsonb_typeof(p_document) <> 'object'
     or not (p_document ?& array['settings', 'groups', 'group_members', 'grants', 'edges'])
     or (select count(*) from jsonb_object_keys(p_document)) <> 5
     or jsonb_typeof(p_document -> 'settings') <> 'object'
     or jsonb_typeof(p_document -> 'groups') <> 'array'
     or jsonb_typeof(p_document -> 'group_members') <> 'array'
     or jsonb_typeof(p_document -> 'grants') <> 'array'
     or jsonb_typeof(p_document -> 'edges') <> 'array' then
    raise exception 'hivra_net: the policy document needs settings, groups, group_members, grants and edges' using errcode = 'HN422';
  end if;

  drop table if exists hn_want_settings, hn_want_groups, hn_want_members, hn_want_grants, hn_want_edges;
  create temp table hn_want_settings (
    network_enabled boolean not null, paused boolean not null,
    buzz_binding_default text not null check (buzz_binding_default in ('allowed', 'forbidden')),
    max_hop_depth integer not null check (max_hop_depth between 1 and 8)
  ) on commit drop;
  create temp table hn_want_groups (id uuid primary key, name text not null) on commit drop;
  create temp table hn_want_members (group_id uuid not null, principal_id uuid not null, primary key (group_id, principal_id)) on commit drop;
  create temp table hn_want_grants (
    layer text not null check (layer in ('ceiling', 'narrow')),
    principal_id uuid, group_id uuid,
    source text not null, mode text not null check (mode in ('none', 'read', 'write')),
    check ((principal_id is null) <> (group_id is null))
  ) on commit drop;
  create unique index on hn_want_grants (layer, coalesce(principal_id, group_id), source);
  create temp table hn_want_edges (
    layer text not null check (layer in ('ceiling', 'narrow')),
    from_principal_id uuid not null, to_principal_id uuid not null,
    mode text not null check (mode in ('deny', 'approve', 'auto')),
    max_messages_per_hour integer check (max_messages_per_hour is null or max_messages_per_hour > 0),
    max_concurrent_runs integer check (max_concurrent_runs is null or max_concurrent_runs > 0),
    check (from_principal_id <> to_principal_id),
    primary key (layer, from_principal_id, to_principal_id)
  ) on commit drop;

  insert into hn_want_settings
  select * from jsonb_to_record(p_document -> 'settings')
    as x(network_enabled boolean, paused boolean, buzz_binding_default text, max_hop_depth integer);
  insert into hn_want_groups
  select * from jsonb_to_recordset(p_document -> 'groups') as x(id uuid, name text);
  insert into hn_want_members
  select * from jsonb_to_recordset(p_document -> 'group_members') as x(group_id uuid, principal_id uuid);
  insert into hn_want_grants
  select layer, principal_id, group_id, lower(source), mode
    from jsonb_to_recordset(p_document -> 'grants') as x(layer text, principal_id uuid, group_id uuid, source text, mode text);
  insert into hn_want_edges
  select * from jsonb_to_recordset(p_document -> 'edges')
    as x(layer text, from_principal_id uuid, to_principal_id uuid, mode text, max_messages_per_hour integer, max_concurrent_runs integer);

  -- References stay inside the organization and name live principals.
  select count(*) into v_bad from (
    select principal_id from hn_want_members
    union all select principal_id from hn_want_grants where principal_id is not null
    union all select from_principal_id from hn_want_edges
    union all select to_principal_id from hn_want_edges
  ) refs
  where not exists (
    select 1 from public.hivra_principals p
     where p.org_id = p_org_id and p.id = refs.principal_id and p.state <> 'left');
  if v_bad > 0 then
    raise exception 'hivra_net: the policy names a principal that is not in this organization or has left' using errcode = 'HN422';
  end if;
  select count(*) into v_bad from (
    select group_id from hn_want_members
    union all select group_id from hn_want_grants where group_id is not null
  ) refs
  where not exists (select 1 from hn_want_groups g where g.id = refs.group_id);
  if v_bad > 0 then
    raise exception 'hivra_net: the policy names a group that is not in the document' using errcode = 'HN422';
  end if;

  -- Only an agent's owner narrows, and only for that agent.
  select count(*) into v_bad from hn_want_grants where layer = 'narrow' and principal_id is null;
  if v_bad > 0 then
    raise exception 'hivra_net: a narrowing grant belongs to one agent, not a group' using errcode = 'HN422';
  end if;

  -- Sources must exist: a team source is a group; an agent source is a principal.
  select count(*) into v_bad from hn_want_grants g
   where (g.source like 'team/%' and not exists (select 1 from hn_want_groups w where w.id::text = substr(g.source, 6)))
      or (g.source like 'agent/%' and not exists (
            select 1 from public.hivra_principals p
             where p.org_id = p_org_id and p.id::text = substr(g.source, 7)));
  if v_bad > 0 then
    raise exception 'hivra_net: a grant names a source that does not exist in this organization' using errcode = 'HN422';
  end if;
  -- A private source is its agent's own; only its ceiling row may restrict it.
  select count(*) into v_bad from hn_want_grants g
   where g.source like 'agent/%' and (g.principal_id is null or g.source <> 'agent/' || g.principal_id::text);
  if v_bad > 0 then
    raise exception 'hivra_net: a private source can only be granted to its own agent' using errcode = 'HN422';
  end if;

  -- Groups keep their name for life in v1.
  select count(*) into v_bad from hn_want_groups w
    join public.hivra_org_groups g on g.org_id = p_org_id and g.id = w.id and g.valid_to_revision is null
   where g.name <> w.name;
  if v_bad > 0 then
    raise exception 'hivra_net: a group cannot be renamed' using errcode = 'HN422';
  end if;
  -- A group id is never reused after it was retired.
  select count(*) into v_bad from hn_want_groups w
   where exists (select 1 from public.hivra_org_groups g where g.org_id = p_org_id and g.id = w.id and g.valid_to_revision is not null);
  if v_bad > 0 then
    raise exception 'hivra_net: a retired group id cannot be reused' using errcode = 'HN422';
  end if;

  -- Differences against the current policy.
  drop table if exists hn_add_grants, hn_del_grants, hn_add_edges, hn_del_edges;
  create temp table hn_add_grants on commit drop as
    select w.* from hn_want_grants w
     where not exists (
       select 1 from public.hivra_brain_grants a
        where a.org_id = p_org_id and a.valid_to_revision is null
          and a.layer = w.layer and a.principal_id is not distinct from w.principal_id
          and a.group_id is not distinct from w.group_id and a.source = w.source and a.mode = w.mode);
  create temp table hn_del_grants on commit drop as
    select a.id, a.layer, a.principal_id, a.group_id from public.hivra_brain_grants a
     where a.org_id = p_org_id and a.valid_to_revision is null
       and not exists (
         select 1 from hn_want_grants w
          where a.layer = w.layer and a.principal_id is not distinct from w.principal_id
            and a.group_id is not distinct from w.group_id and a.source = w.source and a.mode = w.mode);
  create temp table hn_add_edges on commit drop as
    select w.* from hn_want_edges w
     where not exists (
       select 1 from public.hivra_agent_edges a
        where a.org_id = p_org_id and a.valid_to_revision is null
          and a.layer = w.layer and a.from_principal_id = w.from_principal_id and a.to_principal_id = w.to_principal_id
          and a.mode = w.mode
          and a.max_messages_per_hour is not distinct from w.max_messages_per_hour
          and a.max_concurrent_runs is not distinct from w.max_concurrent_runs);
  create temp table hn_del_edges on commit drop as
    select a.id, a.layer, a.from_principal_id, a.to_principal_id from public.hivra_agent_edges a
     where a.org_id = p_org_id and a.valid_to_revision is null
       and not exists (
         select 1 from hn_want_edges w
          where a.layer = w.layer and a.from_principal_id = w.from_principal_id and a.to_principal_id = w.to_principal_id
            and a.mode = w.mode
            and a.max_messages_per_hour is not distinct from w.max_messages_per_hour
            and a.max_concurrent_runs is not distinct from w.max_concurrent_runs);

  select not exists (
    select 1 from public.hivra_org_settings a, hn_want_settings w
     where a.org_id = p_org_id and a.valid_to_revision is null
       and a.network_enabled = w.network_enabled and a.paused = w.paused
       and a.buzz_binding_default = w.buzz_binding_default and a.max_hop_depth = w.max_hop_depth)
    into v_settings_changed;
  select count(*) into v_n_groups_add from hn_want_groups w
   where not exists (select 1 from public.hivra_org_groups g where g.org_id = p_org_id and g.id = w.id and g.valid_to_revision is null);
  select count(*) into v_n_groups_del from public.hivra_org_groups g
   where g.org_id = p_org_id and g.valid_to_revision is null and not exists (select 1 from hn_want_groups w where w.id = g.id);
  select count(*) into v_n_members_add from hn_want_members w
   where not exists (select 1 from public.hivra_org_group_members m
                      where m.org_id = p_org_id and m.valid_to_revision is null
                        and m.group_id = w.group_id and m.principal_id = w.principal_id);
  select count(*) into v_n_members_del from public.hivra_org_group_members m
   where m.org_id = p_org_id and m.valid_to_revision is null
     and not exists (select 1 from hn_want_members w where w.group_id = m.group_id and w.principal_id = m.principal_id);
  select count(*) into v_n_grants_add from hn_add_grants;
  select count(*) into v_n_grants_del from hn_del_grants;
  select count(*) into v_n_edges_add from hn_add_edges;
  select count(*) into v_n_edges_del from hn_del_edges;

  if not v_settings_changed and v_n_groups_add + v_n_groups_del + v_n_members_add + v_n_members_del
       + v_n_grants_add + v_n_grants_del + v_n_edges_add + v_n_edges_del = 0 then
    return v_current;
  end if;

  -- Authorization by role. A member changes only narrowing rows, and only for
  -- agents they own.
  if v_role = 'member' then
    if v_settings_changed or v_n_groups_add + v_n_groups_del + v_n_members_add + v_n_members_del > 0
       or exists (select 1 from hn_add_grants where layer = 'ceiling')
       or exists (select 1 from hn_del_grants where layer = 'ceiling')
       or exists (select 1 from hn_add_edges where layer = 'ceiling')
       or exists (select 1 from hn_del_edges where layer = 'ceiling') then
      raise exception 'hivra_net: a member can only narrow access for their own agents' using errcode = 'HN403';
    end if;
    select count(*) into v_bad from (
      select principal_id as pid from hn_add_grants
      union all select principal_id from hn_del_grants
    ) g
    where not exists (select 1 from public.hivra_principals p
                       where p.org_id = p_org_id and p.id = g.pid and p.owner_user_id = p_author_user_id);
    if v_bad > 0 then
      raise exception 'hivra_net: a member can only narrow access for their own agents' using errcode = 'HN403';
    end if;
    -- An edge may be narrowed by the owner of either end.
    select count(*) into v_bad from (
      select from_principal_id as a, to_principal_id as b from hn_add_edges
      union all select from_principal_id, to_principal_id from hn_del_edges
    ) e
    where not exists (select 1 from public.hivra_principals p
                       where p.org_id = p_org_id and p.owner_user_id = p_author_user_id and p.id in (e.a, e.b));
    if v_bad > 0 then
      raise exception 'hivra_net: a member can only narrow access for their own agents' using errcode = 'HN403';
    end if;
  end if;

  -- Attenuation: a new narrowing row never exceeds the ceiling it narrows.
  select count(*) into v_bad from hn_add_grants n
   where n.layer = 'narrow'
     and public.hivra_net_mode_rank(n.mode) > (
       case
         when exists (
           select 1 from hn_want_grants c
            where c.layer = 'ceiling' and c.mode = 'none'
              and (c.principal_id = n.principal_id
                   or c.group_id in (select m.group_id from hn_want_members m where m.principal_id = n.principal_id))
              and c.source = n.source) then 0
         when n.source like 'agent/%' then
           coalesce((select public.hivra_net_mode_rank(c.mode) from hn_want_grants c
                      where c.layer = 'ceiling' and c.principal_id = n.principal_id and c.source = n.source), 2)
         else
           coalesce((select max(public.hivra_net_mode_rank(c.mode)) from hn_want_grants c
                      where c.layer = 'ceiling' and c.source = n.source
                        and (c.principal_id = n.principal_id
                             or c.group_id in (select m.group_id from hn_want_members m where m.principal_id = n.principal_id))), 0)
       end);
  if v_bad > 0 then
    raise exception 'hivra_net: a narrowing grant cannot exceed the organization ceiling' using errcode = 'HN422';
  end if;
  select count(*) into v_bad from hn_add_edges n
   where n.layer = 'narrow'
     and not exists (
       select 1 from hn_want_edges c
        where c.layer = 'ceiling' and c.from_principal_id = n.from_principal_id and c.to_principal_id = n.to_principal_id
          and public.hivra_net_edge_rank(n.mode) <= public.hivra_net_edge_rank(c.mode)
          and (n.max_messages_per_hour is null or c.max_messages_per_hour is null or n.max_messages_per_hour <= c.max_messages_per_hour)
          and (n.max_concurrent_runs is null or c.max_concurrent_runs is null or n.max_concurrent_runs <= c.max_concurrent_runs));
  if v_bad > 0 then
    raise exception 'hivra_net: a narrowing edge cannot exceed the organization ceiling' using errcode = 'HN422';
  end if;

  -- Write the next revision.
  v_new := v_current + 1;
  insert into public.hivra_policy_revisions(org_id, revision, author_user_id, reason)
  values (p_org_id, v_new, p_author_user_id, p_reason);

  if v_settings_changed then
    update public.hivra_org_settings set valid_to_revision = v_new
     where org_id = p_org_id and valid_to_revision is null;
    insert into public.hivra_org_settings(org_id, valid_from_revision, network_enabled, paused, buzz_binding_default, max_hop_depth)
    select p_org_id, v_new, network_enabled, paused, buzz_binding_default, max_hop_depth from hn_want_settings;
  end if;

  update public.hivra_brain_grants set valid_to_revision = v_new
   where org_id = p_org_id and id in (select id from hn_del_grants);
  update public.hivra_agent_edges set valid_to_revision = v_new
   where org_id = p_org_id and id in (select id from hn_del_edges);
  update public.hivra_org_group_members m set valid_to_revision = v_new
   where m.org_id = p_org_id and m.valid_to_revision is null
     and not exists (select 1 from hn_want_members w where w.group_id = m.group_id and w.principal_id = m.principal_id);
  update public.hivra_org_groups g set valid_to_revision = v_new
   where g.org_id = p_org_id and g.valid_to_revision is null
     and not exists (select 1 from hn_want_groups w where w.id = g.id);

  insert into public.hivra_org_groups(org_id, id, name, valid_from_revision)
  select p_org_id, w.id, w.name, v_new from hn_want_groups w
   where not exists (select 1 from public.hivra_org_groups g where g.org_id = p_org_id and g.id = w.id and g.valid_to_revision is null);
  insert into public.hivra_org_group_members(org_id, group_id, principal_id, valid_from_revision)
  select p_org_id, w.group_id, w.principal_id, v_new from hn_want_members w
   where not exists (select 1 from public.hivra_org_group_members m
                      where m.org_id = p_org_id and m.valid_to_revision is null
                        and m.group_id = w.group_id and m.principal_id = w.principal_id);
  insert into public.hivra_brain_grants(org_id, layer, principal_id, group_id, source, mode, author_user_id, valid_from_revision)
  select p_org_id, layer, principal_id, group_id, source, mode, p_author_user_id, v_new from hn_add_grants;
  insert into public.hivra_agent_edges(org_id, layer, from_principal_id, to_principal_id, mode,
                                       max_messages_per_hour, max_concurrent_runs, author_user_id, valid_from_revision)
  select p_org_id, layer, from_principal_id, to_principal_id, mode,
         max_messages_per_hour, max_concurrent_runs, p_author_user_id, v_new from hn_add_edges;

  update public.hivra_orgs set current_revision = v_new where id = p_org_id;

  perform public.hivra_net_append_audit(
    p_org_id, 'policy.publish', p_author_user_id, null, null, null, 'n/a', null, p_reason, v_new, null, null,
    jsonb_build_object(
      'role', v_role, 'settingsChanged', v_settings_changed,
      'groups', v_n_groups_add + v_n_groups_del, 'groupMembers', v_n_members_add + v_n_members_del,
      'grantsAdded', v_n_grants_add, 'grantsEnded', v_n_grants_del,
      'edgesAdded', v_n_edges_add, 'edgesEnded', v_n_edges_del));
  return v_new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads for the evaluator: one round trip, one consistent view
-- ---------------------------------------------------------------------------

-- The policy as it stood at a revision, or null when the organization or the
-- revision does not exist.
create or replace function public.hivra_net_policy_snapshot(p_org_id uuid, p_revision bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current bigint;
begin
  select current_revision into v_current from public.hivra_orgs where id = p_org_id;
  if v_current is null or p_revision is null or p_revision < 1 or p_revision > v_current then
    return null;
  end if;
  return jsonb_build_object(
    'orgId', p_org_id,
    'revision', p_revision,
    'settings', (
      select jsonb_build_object(
        'networkEnabled', s.network_enabled, 'paused', s.paused,
        'buzzBindingDefault', s.buzz_binding_default, 'maxHopDepth', s.max_hop_depth)
        from public.hivra_org_settings s
       where s.org_id = p_org_id and s.valid_from_revision <= p_revision
         and (s.valid_to_revision is null or p_revision < s.valid_to_revision)),
    'groups', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name) order by g.id)
        from public.hivra_org_groups g
       where g.org_id = p_org_id and g.valid_from_revision <= p_revision
         and (g.valid_to_revision is null or p_revision < g.valid_to_revision)), '[]'::jsonb),
    'groupMembers', coalesce((
      select jsonb_agg(jsonb_build_object('groupId', m.group_id, 'principalId', m.principal_id) order by m.group_id, m.principal_id)
        from public.hivra_org_group_members m
       where m.org_id = p_org_id and m.valid_from_revision <= p_revision
         and (m.valid_to_revision is null or p_revision < m.valid_to_revision)), '[]'::jsonb),
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', b.id, 'layer', b.layer, 'principalId', b.principal_id, 'groupId', b.group_id,
               'source', b.source, 'mode', b.mode) order by b.id)
        from public.hivra_brain_grants b
       where b.org_id = p_org_id and b.valid_from_revision <= p_revision
         and (b.valid_to_revision is null or p_revision < b.valid_to_revision)), '[]'::jsonb),
    'edges', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', e.id, 'layer', e.layer, 'fromPrincipalId', e.from_principal_id,
               'toPrincipalId', e.to_principal_id, 'mode', e.mode,
               'maxMessagesPerHour', e.max_messages_per_hour, 'maxConcurrentRuns', e.max_concurrent_runs) order by e.id)
        from public.hivra_agent_edges e
       where e.org_id = p_org_id and e.valid_from_revision <= p_revision
         and (e.valid_to_revision is null or p_revision < e.valid_to_revision)), '[]'::jsonb)
  );
end;
$$;

-- Everything one authorization decision needs, read live: the newest revision,
-- the requested revision's policy, and the live state of the requesting
-- principal and (for agent-to-agent) its peer. A principal is only found
-- through the organization the request names.
create or replace function public.hivra_net_authz_context(
  p_org_id uuid,
  p_principal_id uuid,
  p_peer_principal_id uuid default null,
  p_revision bigint default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_current bigint;
  v_revision bigint;
begin
  select current_revision into v_current from public.hivra_orgs where id = p_org_id;
  v_revision := coalesce(p_revision, v_current);
  return jsonb_build_object(
    'orgFound', v_current is not null,
    'currentRevision', v_current,
    'requestedRevision', v_revision,
    'policy', case when v_current is null then null else public.hivra_net_policy_snapshot(p_org_id, v_revision) end,
    'subject', (
      select jsonb_build_object(
               'principalId', p.id, 'orgId', p.org_id, 'state', p.state, 'ownerUserId', p.owner_user_id,
               'agentIdentityId', p.agent_identity_id,
               'memberActive', (m.user_id is not null and m.removed_at is null))
        from public.hivra_principals p
        left join public.hivra_org_members m on m.org_id = p.org_id and m.user_id = p.owner_user_id
       where p.org_id = p_org_id and p.id = p_principal_id),
    'peer', case when p_peer_principal_id is null then null else (
      select jsonb_build_object(
               'principalId', p.id, 'orgId', p.org_id, 'state', p.state, 'ownerUserId', p.owner_user_id,
               'agentIdentityId', p.agent_identity_id,
               'memberActive', (m.user_id is not null and m.removed_at is null))
        from public.hivra_principals p
        left join public.hivra_org_members m on m.org_id = p.org_id and m.user_id = p.owner_user_id
       where p.org_id = p_org_id and p.id = p_peer_principal_id) end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Responsibility record
-- ---------------------------------------------------------------------------

create or replace function public.hivra_net_record_responsibility(
  p_org_id uuid, p_service text, p_control_plane_operator text, p_credential_custodian text,
  p_spend_owner text, p_capacity_operator text, p_recovery_owner text, p_support_party text,
  p_recorded_by text, p_note text default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not exists (select 1 from public.hivra_orgs where id = p_org_id) then
    raise exception 'hivra_net: unknown organization' using errcode = 'HN404';
  end if;
  insert into public.hivra_network_responsibilities as r(
    org_id, service, control_plane_operator, credential_custodian, spend_owner,
    capacity_operator, recovery_owner, support_party, recorded_by, note)
  values (p_org_id, p_service, p_control_plane_operator, p_credential_custodian, p_spend_owner,
          p_capacity_operator, p_recovery_owner, p_support_party, p_recorded_by, p_note)
  on conflict (org_id, service) do update set
    control_plane_operator = excluded.control_plane_operator,
    credential_custodian = excluded.credential_custodian,
    spend_owner = excluded.spend_owner,
    capacity_operator = excluded.capacity_operator,
    recovery_owner = excluded.recovery_owner,
    support_party = excluded.support_party,
    recorded_by = excluded.recorded_by,
    recorded_at = clock_timestamp(),
    note = excluded.note;
  perform public.hivra_net_append_audit(
    p_org_id, 'responsibility.record', p_recorded_by, null, null, p_service, 'n/a', null, null, null, null, null, '{}'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Erasure: account deletion or organization deletion. The only path that
-- removes policy history and the audit log.
-- ---------------------------------------------------------------------------

create or replace function public.hivra_net_erase_org(p_org_id uuid)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_audit integer;
begin
  perform set_config('hivra.net_erase_org', p_org_id::text, true);
  delete from public.hivra_network_audit where org_id = p_org_id;
  get diagnostics v_audit = row_count;
  delete from public.hivra_orgs where id = p_org_id;
  perform set_config('hivra.net_erase_org', '', true);
  return v_audit;
end;
$$;

create or replace function public.hivra_net_erase_personal_org(p_user_id text)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_org uuid;
begin
  select id into v_org from public.hivra_orgs where kind = 'personal' and personal_owner_user_id = p_user_id;
  if v_org is null then
    return 0;
  end if;
  -- Only an organization of one is erased with its account; a team the user
  -- belongs to is theirs only to leave.
  return public.hivra_net_erase_org(v_org) + 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- Access: service role only
-- ---------------------------------------------------------------------------

alter table public.hivra_orgs enable row level security;
alter table public.hivra_org_members enable row level security;
alter table public.hivra_policy_revisions enable row level security;
alter table public.hivra_principals enable row level security;
alter table public.hivra_org_settings enable row level security;
alter table public.hivra_org_groups enable row level security;
alter table public.hivra_org_group_members enable row level security;
alter table public.hivra_brain_grants enable row level security;
alter table public.hivra_agent_edges enable row level security;
alter table public.hivra_network_responsibilities enable row level security;
alter table public.hivra_card_signing_keys enable row level security;
alter table public.hivra_network_audit enable row level security;

revoke all on public.hivra_orgs, public.hivra_org_members, public.hivra_policy_revisions,
  public.hivra_principals, public.hivra_org_settings, public.hivra_org_groups,
  public.hivra_org_group_members, public.hivra_brain_grants, public.hivra_agent_edges,
  public.hivra_network_responsibilities, public.hivra_card_signing_keys,
  public.hivra_network_audit
  from public, anon, authenticated, service_role;

-- Reads only. Every write to these tables goes through a function above.
grant select on public.hivra_orgs, public.hivra_org_members, public.hivra_policy_revisions,
  public.hivra_principals, public.hivra_org_settings, public.hivra_org_groups,
  public.hivra_org_group_members, public.hivra_brain_grants, public.hivra_agent_edges,
  public.hivra_network_responsibilities, public.hivra_card_signing_keys,
  public.hivra_network_audit
  to service_role;

-- The signing key registry is the one table the service role writes directly:
-- registering a key, retiring it, revoking it. A trigger makes the status
-- one-way and keys cannot be deleted.
grant insert, update on public.hivra_card_signing_keys to service_role;

revoke all on function
  public.hivra_net_mode_rank(text), public.hivra_net_edge_rank(text),
  public.hivra_net_guard_history(), public.hivra_net_guard_truncate(), public.hivra_net_guard_audit(),
  public.hivra_net_guard_member(), public.hivra_net_guard_principal(), public.hivra_net_guard_card_key(),
  public.hivra_net_audit_entry_hash(uuid, bigint, timestamptz, text, text, uuid, uuid, text, text, text, text, bigint, text, integer, jsonb, text),
  public.hivra_net_move_principal(uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;

revoke all on function
  public.hivra_net_append_audit(uuid, text, text, uuid, uuid, text, text, text, text, bigint, text, integer, jsonb),
  public.hivra_net_verify_audit_chain(uuid),
  public.hivra_net_create_org(text, text, text),
  public.hivra_net_ensure_personal_org(text),
  public.hivra_net_add_member(uuid, text, text, text),
  public.hivra_net_remove_member(uuid, text, text),
  public.hivra_net_begin_join(uuid, uuid, text, text),
  public.hivra_net_set_principal_key(uuid, uuid, text, text),
  public.hivra_net_transition_principal(uuid, uuid, text, text, text),
  public.hivra_net_publish_policy_revision(uuid, bigint, text, text, jsonb),
  public.hivra_net_policy_snapshot(uuid, bigint),
  public.hivra_net_authz_context(uuid, uuid, uuid, bigint),
  public.hivra_net_record_responsibility(uuid, text, text, text, text, text, text, text, text, text),
  public.hivra_net_erase_org(uuid),
  public.hivra_net_erase_personal_org(text)
  from public, anon, authenticated;

grant execute on function
  public.hivra_net_append_audit(uuid, text, text, uuid, uuid, text, text, text, text, bigint, text, integer, jsonb),
  public.hivra_net_verify_audit_chain(uuid),
  public.hivra_net_create_org(text, text, text),
  public.hivra_net_ensure_personal_org(text),
  public.hivra_net_add_member(uuid, text, text, text),
  public.hivra_net_remove_member(uuid, text, text),
  public.hivra_net_begin_join(uuid, uuid, text, text),
  public.hivra_net_set_principal_key(uuid, uuid, text, text),
  public.hivra_net_transition_principal(uuid, uuid, text, text, text),
  public.hivra_net_publish_policy_revision(uuid, bigint, text, text, jsonb),
  public.hivra_net_policy_snapshot(uuid, bigint),
  public.hivra_net_authz_context(uuid, uuid, uuid, bigint),
  public.hivra_net_record_responsibility(uuid, text, text, text, text, text, text, text, text, text),
  public.hivra_net_erase_org(uuid),
  public.hivra_net_erase_personal_org(text)
  to service_role;
