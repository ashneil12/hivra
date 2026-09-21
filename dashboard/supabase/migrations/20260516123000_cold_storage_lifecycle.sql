-- Cold-storage lifecycle state and dashboard-side archive bookkeeping.
--
-- This intentionally preserves every lifecycle value already accepted in
-- production, then adds the cold-storage lock/destination states from
-- docs/cold-storage-orchestration.md. Narrowing the constraint to only the
-- new state-machine table would break existing provisioning/failed/deleting
-- rows during normal dashboard flows.

alter table public.hermes_instances
  drop constraint if exists hermes_instances_lifecycle_state_check;

alter table public.hermes_instances
  add constraint hermes_instances_lifecycle_state_check
  check (lifecycle_state in (
    'pending',
    'provisioning',
    'active',
    'paused',
    'suspended',
    'deleting',
    'deleted',
    'failed',
    'archiving',
    'cold_archived',
    'restoring',
    'pending_deletion'
  ));

alter table public.hermes_instances
  add column if not exists archive_uri text,
  add column if not exists archived_at timestamptz,
  add column if not exists archive_size_bytes bigint,
  add column if not exists archive_sha256 text,
  add column if not exists archive_count integer not null default 0,
  add column if not exists lifecycle_substate text,
  add column if not exists notifications_sent jsonb not null default '{}'::jsonb;

alter table public.hermes_instances
  drop constraint if exists hermes_instances_archive_sha256_check;

alter table public.hermes_instances
  add constraint hermes_instances_archive_sha256_check
  check (archive_sha256 is null or archive_sha256 ~ '^[a-f0-9]{64}$');

alter table public.hermes_instances
  drop constraint if exists hermes_instances_archive_size_bytes_check;

alter table public.hermes_instances
  add constraint hermes_instances_archive_size_bytes_check
  check (archive_size_bytes is null or archive_size_bytes >= 0);

alter table public.hermes_instances
  drop constraint if exists hermes_instances_archive_count_check;

alter table public.hermes_instances
  add constraint hermes_instances_archive_count_check
  check (archive_count >= 0);

create index if not exists hermes_instances_lifecycle_paused_archive_idx
  on public.hermes_instances (last_lifecycle_transition_at)
  where lifecycle_state = 'paused'
    and deleted_at is null
    and archive_uri is null;

create index if not exists hermes_instances_cold_archived_idx
  on public.hermes_instances (archived_at)
  where lifecycle_state in ('cold_archived', 'pending_deletion')
    and deleted_at is null;

comment on column public.hermes_instances.archive_uri is
  'Storage Box archive path for the latest immutable cold-storage generation, e.g. free/<instance-id>/data-<ts>.tar.zst.';

comment on column public.hermes_instances.archived_at is
  'Timestamp from the latest cold-storage manifest. Consumers treat the manifest, not the data file alone, as archive completion.';

comment on column public.hermes_instances.archive_size_bytes is
  'Byte size recorded in the latest cold-storage manifest and used by archive/restore integrity checks.';

comment on column public.hermes_instances.archive_sha256 is
  'SHA256 recorded in the latest cold-storage manifest. Restore must verify this before extracting.';

comment on column public.hermes_instances.archive_count is
  'Number of manifest generations known for this instance during backfill or retention bookkeeping.';

comment on column public.hermes_instances.lifecycle_substate is
  'Human-readable lifecycle stage for long-running operations such as restoring from cold storage.';

comment on column public.hermes_instances.notifications_sent is
  'Send-once ledger for cold-storage lifecycle emails, keyed by notification name.';
