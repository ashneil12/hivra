-- Auto-seed daily-brief idempotency marker.
--
-- The gated /api/cron/seed-daily-brief sweep auto-creates ONE "Daily brief"
-- scheduled job per running agent (08:00 UTC, deliver=local) so the command
-- panel's "Today's brief" is written by the user's own agent instead of a static
-- heuristic. This column is the per-instance idempotency stamp: written once
-- after a successful seed, so the sweep never re-seeds the same agent, and
-- selection requires daily_brief_seeded_at IS NULL.
--
-- Additive + nullable + idempotent. Existing rows are unaffected (NULL = never
-- seeded), so enabling the sweep does not retroactively touch live agents. The
-- seeded "Daily brief" job is a platform job and is exempt from the free-tier
-- one-standing-task limit (see /api/instances/[id]/cron requireCreateAllowed).

alter table public.hermes_instances
  add column if not exists daily_brief_seeded_at timestamptz;

comment on column public.hermes_instances.daily_brief_seeded_at is
  'When the auto-seed daily-brief sweep created this agent''s "Daily brief" scheduled job. NULL = never seeded; set once, never re-seeded (see /api/cron/seed-daily-brief).';

-- Partial index over the eligible-for-seeding population (not yet seeded), so the
-- sweep''s candidate query stays cheap as the fleet grows.
create index if not exists idx_hermes_instances_daily_brief_unseeded
  on public.hermes_instances (status)
  where daily_brief_seeded_at is null and deleted_at is null;
