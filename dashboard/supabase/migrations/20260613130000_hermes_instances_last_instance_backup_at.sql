-- Rotation cursor for the daily granular per-instance restic backups
-- (/api/cron/daily-instance-backups).
--
-- Without a cursor the candidate query ordered by created_at ASC + LIMIT N, so
-- every run picked the SAME oldest N paid instances forever — the rest of the
-- paid fleet was never backed up. This column is the convergence cursor: each
-- successful per-row backup stamps last_instance_backup_at = now(), and the
-- candidate query orders by it ascending NULLS FIRST + filters to rows that are
-- NULL or older than the per-day cutoff. Never-backed-up rows (NULL) sort first,
-- so the sweep advances to the next-oldest cohort instead of re-rolling the
-- oldest N. Mirrors the fleet-sync `last_synced_at` convergence fix on
-- redeploy-webui-instances.
--
-- Additive + reversible (drop the column). Nullable: existing rows start NULL
-- and are therefore treated as "never backed up" => due immediately.
-- Idempotent (IF NOT EXISTS).
alter table public.hermes_instances
  add column if not exists last_instance_backup_at timestamptz;

comment on column public.hermes_instances.last_instance_backup_at is
  'Rotation cursor for /api/cron/daily-instance-backups. Stamped now() on each '
  'successful granular restic backup; the candidate query orders by it ascending '
  'NULLS FIRST and skips rows backed up within the last ~20h so the sweep '
  'converges the whole paid fleet instead of re-backing-up the oldest N forever. '
  'Mirrors hermes_instances.last_synced_at (fleet-sync convergence cursor).';

-- Index for the cursor scan: filter by tier + the lifecycle/status equality
-- predicates are highly selective, but the ordering key is last_instance_backup_at
-- (with NULLS FIRST). A composite (resource_tier, last_instance_backup_at) lets
-- the planner satisfy the tier filter + the order/cursor predicate from one
-- index. NULLS FIRST matches the query's .order(..., { nullsFirst: true }).
create index if not exists hermes_instances_tier_last_backup_idx
  on public.hermes_instances (resource_tier, last_instance_backup_at asc nulls first);
