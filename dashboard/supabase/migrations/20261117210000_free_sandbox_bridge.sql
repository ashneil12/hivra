-- The free sandbox bridge's own records (dashboard/src/lib/hivra/free-sandbox, `BridgeStore`). Nothing reads or
-- writes these until the free sandbox switch is on; they hold workspace ids, sandbox ids, server ids and counts only,
-- never a person's details, a code or a token. Service role only.
--
-- Free archives are kept here, never in cold_archived rows, so the cold retention sweep never sees them: a packed free
-- sandbox stays until its workspace is deleted.
--
-- Additive and idempotent.

-- The pool servers Free may place on, and the cores it may use on each. The paid reserve and paid waits are read
-- from the paid side's own capacity when the bridge runs, not stored here.
create table if not exists public.free_sandbox_pool_servers (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  cpus        numeric not null check (cpus > 0),
  enabled     boolean not null default false,
  -- Until when the free AI refuses this server's address (OpenCode counts its free limit per address); null: not.
  ai_refused_until timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One free workspace's sandbox. `server_id` is null while packed; `archive_*` is the verified copy in storage.
create table if not exists public.free_sandbox_placements (
  org_id          uuid primary key,
  sandbox_id      uuid not null unique,
  computer_id     uuid not null unique,
  owner_hash      text not null check (owner_hash ~ '^[0-9a-f]{64}$'),
  machine_id      uuid,
  server_id       text references public.free_sandbox_pool_servers(id),
  state           text not null check (state in ('placing', 'awake', 'stopped', 'packing', 'packed', 'restoring', 'flagged')),
  placed_at       timestamptz not null,
  state_at        timestamptz not null,
  archive_location text,
  archive_sha256  text check (archive_sha256 is null or archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes   bigint check (archive_bytes is null or archive_bytes >= 0),
  problem         text check (problem is null or length(problem) <= 200),
  constraint free_sandbox_placements_server_by_state check (
    (state = 'packed') = (server_id is null)
  ),
  constraint free_sandbox_placements_archive_whole check (
    (archive_location is null) = (archive_sha256 is null) and (archive_sha256 is null) = (archive_bytes is null)
  ),
  constraint free_sandbox_placements_packed_has_archive check (state <> 'packed' or archive_sha256 is not null)
);
create index if not exists free_sandbox_placements_server_state
  on public.free_sandbox_placements (server_id, state) where server_id is not null;

-- Wakes that wait for room, oldest first.
create table if not exists public.free_sandbox_wakes (
  org_id     uuid primary key references public.free_sandbox_placements(org_id) on delete cascade,
  wanted_at  timestamptz not null
);
create index if not exists free_sandbox_wakes_wanted_at on public.free_sandbox_wakes (wanted_at);

-- Workspaces told to wait for a place.
create table if not exists public.free_sandbox_waitlist (
  org_id      uuid primary key,
  waiting_at  timestamptz not null default now()
);

-- The free AI's replies per server and UTC day: answered, refused by its limit, failed another way.
create table if not exists public.free_sandbox_ai_days (
  server_id  text not null references public.free_sandbox_pool_servers(id) on delete cascade,
  day        date not null,
  answered   integer not null default 0 check (answered >= 0),
  refused    integer not null default 0 check (refused >= 0),
  failed     integer not null default 0 check (failed >= 0),
  primary key (server_id, day)
);

-- The bridge's single row of state: the operator events feed's cursor.
create table if not exists public.free_sandbox_state (
  id            boolean primary key default true check (id),
  events_cursor text check (events_cursor is null or length(events_cursor) <= 200),
  updated_at    timestamptz not null default now()
);

do $tables$
declare t text;
begin
  foreach t in array array[
    'free_sandbox_pool_servers', 'free_sandbox_placements', 'free_sandbox_wakes',
    'free_sandbox_waitlist', 'free_sandbox_ai_days', 'free_sandbox_state'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
    execute format('revoke all on public.%I from anon, authenticated', t);
  end loop;
end;
$tables$;

comment on table public.free_sandbox_placements is
  'Free sandbox per workspace: where it is and its verified stored copy. Erased only when the workspace is deleted.';
comment on table public.free_sandbox_ai_days is
  'Free AI replies per pool server and UTC day: answered, refused by the free limit (machine.ai_limit), failed otherwise.';
