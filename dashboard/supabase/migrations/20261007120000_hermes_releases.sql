-- Hermes agent release registry: the dashboard, not a floating `:stable` tag,
-- decides which agent image each box runs.
--
-- Why: every box followed the single `:stable` tag, so publishing an image was
-- a fleet-wide release with no staging, no per-box pin, no fleet rollback, and
-- no record of which version a box ran. The hourly idle-gated roller, the daily
-- fleet-sync cron and the console UPDATE NOW button now resolve an immutable
-- `repo@sha256:...` reference from this table.
--
-- Additive and rerun-safe. Nothing reads these objects until the application
-- code that uses them ships, and every new instance column is nullable (or has
-- a constant default), so existing rows and running code are unaffected.
--
-- Access: service role only. Row level security is on with no policy, and
-- every API role is revoked, so the tables are unreachable through PostgREST.

create table if not exists public.hermes_releases (
  id uuid primary key default gen_random_uuid(),
  -- Registry repository without tag or digest, e.g. ghcr.io/<owner>/<name>.
  -- A box only receives releases of the repository its compose already runs.
  image_repo text not null check (image_repo ~ '^[a-z0-9][a-z0-9._:/-]*$'),
  -- Human version label, e.g. 0.21.5 or 0.21.5-ab12cd3.
  version text not null check (length(version) between 1 and 128),
  -- Immutable content digest of the image (manifest or index).
  digest text not null check (digest ~ '^sha256:[0-9a-f]{64}$'),
  -- canary: only boxes enrolled in the canary channel receive it.
  -- stable: every box is eligible, limited by rollout_percent and the pilot list.
  channel text not null default 'canary' check (channel in ('canary', 'stable')),
  -- Share of stable-channel boxes that receive it (0-100), by a stable hash of
  -- (release, box): a box admitted at 10% stays admitted at 100%.
  rollout_percent numeric(5, 2) not null default 0
    check (rollout_percent >= 0 and rollout_percent <= 100),
  -- Boxes that receive a stable release regardless of rollout_percent (the
  -- "1 box" stage).
  pilot_instance_ids uuid[] not null default '{}',
  -- A halted release is never offered or rolled again; boxes running it are
  -- moved back to the newest release that is not halted.
  halted boolean not null default false,
  halted_reason text,
  halted_at timestamptz,
  halted_by text,
  notes text,
  created_by text,
  created_at timestamptz not null default now(),
  promoted_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint hermes_releases_repo_digest_key unique (image_repo, digest),
  constraint hermes_releases_halted_consistent
    check (halted or (halted_reason is null and halted_at is null))
);

comment on table public.hermes_releases is
  'Hermes agent releases: immutable image digest per version, with channel, rollout percentage, pilot boxes and a halt flag. Service role only.';

create index if not exists hermes_releases_repo_created_idx
  on public.hermes_releases (image_repo, created_at desc);

-- Append-only record of what happened to a release on a box. The halt policy
-- reads it, and it is the audit trail for ops decisions.
create table if not exists public.hermes_release_events (
  id bigint generated always as identity primary key,
  release_id uuid references public.hermes_releases (id) on delete set null,
  instance_id uuid,
  kind text not null check (kind in (
    'registered', 'promoted', 'halted', 'unhalted',
    'updated', 'failed', 'rolled_back', 'paused'
  )),
  digest text,
  detail text,
  actor text,
  created_at timestamptz not null default now()
);

comment on table public.hermes_release_events is
  'Append-only release log: ops decisions (registered, promoted, halted) and per-box outcomes (updated, failed, rolled_back, paused). Service role only.';

create index if not exists hermes_release_events_release_idx
  on public.hermes_release_events (release_id, created_at desc);
create index if not exists hermes_release_events_instance_idx
  on public.hermes_release_events (instance_id, created_at desc);

alter table public.hermes_releases enable row level security;
alter table public.hermes_release_events enable row level security;

revoke all on public.hermes_releases from public, anon, authenticated;
revoke all on public.hermes_release_events from public, anon, authenticated;
revoke all on sequence public.hermes_release_events_id_seq from public, anon, authenticated;
grant all on public.hermes_releases to service_role;
grant all on public.hermes_release_events to service_role;
grant usage, select on sequence public.hermes_release_events_id_seq to service_role;

-- Per-box state: which release channel it follows, what it last reported
-- running, and the health of its update stack.
alter table public.hermes_instances
  add column if not exists release_channel text not null default 'stable',
  add column if not exists agent_image_digest text,
  add column if not exists agent_version text,
  add column if not exists agent_release_id uuid references public.hermes_releases (id) on delete set null,
  add column if not exists agent_image_reported_at timestamptz,
  add column if not exists update_stack_version integer,
  add column if not exists update_health text,
  add column if not exists update_health_detail text,
  add column if not exists update_health_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'hermes_instances_release_channel_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_release_channel_check
      check (release_channel in ('stable', 'canary'));
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'hermes_instances_update_health_check'
  ) then
    alter table public.hermes_instances
      add constraint hermes_instances_update_health_check
      check (update_health is null or update_health in ('ok', 'paused', 'failed', 'rolled_back'));
  end if;
end
$$;

comment on column public.hermes_instances.release_channel is
  'Release channel the box follows: stable (default) or canary (receives canary-channel releases first).';
comment on column public.hermes_instances.agent_image_digest is
  'Image digest the box last reported running (sha256:...). Null until the box reports.';
comment on column public.hermes_instances.agent_version is
  'Version label of agent_release_id when the reported digest matches a registered release.';
comment on column public.hermes_instances.update_stack_version is
  'Version of the box-side update stack (roll script) that last reported; 2+ resolves digests from the dashboard.';
comment on column public.hermes_instances.update_health is
  'Update stack health the box last reported: ok, paused (roller paused itself), failed, rolled_back. Null when never reported.';

-- Ops view of boxes whose update stack needs attention.
create index if not exists hermes_instances_update_health_idx
  on public.hermes_instances (update_health_at desc)
  where update_health is not null and update_health <> 'ok';
