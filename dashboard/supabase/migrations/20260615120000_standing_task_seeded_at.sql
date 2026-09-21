-- Auto-seed standing-task idempotency marker.
--
-- The gated /api/cron/seed-standing-tasks sweep auto-creates ONE daily standing
-- task for newly-running agents that captured a goal/first_task, so the "it
-- worked while you were away" loop happens without the user setting it up. This
-- column is the per-instance idempotency stamp: it is written once, after a
-- successful seed, so the sweep never re-seeds the same agent. The sweep's
-- 0-existing-jobs box-list guard is the second safety net (this column is the
-- first), and selection requires standing_task_seeded_at IS NULL.
--
-- Additive + nullable + idempotent. Existing rows are unaffected (NULL = never
-- seeded), so enabling the sweep does not retroactively touch live agents.

alter table public.hermes_instances
  add column if not exists standing_task_seeded_at timestamptz;

comment on column public.hermes_instances.standing_task_seeded_at is
  'When the auto-seed standing-task sweep created this agent''s daily standing task. NULL = never seeded; set once, never re-seeded (see /api/cron/seed-standing-tasks).';

-- Partial index over the eligible-for-seeding population (not yet seeded), so
-- the sweep''s candidate query stays cheap as the fleet grows.
create index if not exists idx_hermes_instances_standing_task_unseeded
  on public.hermes_instances (status)
  where standing_task_seeded_at is null and deleted_at is null;
