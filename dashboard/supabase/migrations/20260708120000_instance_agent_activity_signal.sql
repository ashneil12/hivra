-- Agent-side activity signal for the inactivity sweep.
--
-- WHY
-- The inactivity sweep judged dormancy on `last_activity_at`, which only moves
-- on DASHBOARD-originated actions. Users who talk to their agent exclusively
-- over Telegram / Discord / the box's own web UI generate zero dashboard
-- activity, so an actively-used agent looked idle and was paused -> reclaimed
-- -> cold-archived.
--
-- A second gate (instance_usage_snapshots.sessions > 0) was added in #378, but
-- it cannot distinguish "the harvester probed this box and it was genuinely
-- idle" from "the harvester never successfully probed this box". An idle agent
-- produces NO snapshot row at all (the harvest's `skippedEmpty` path), exactly
-- like a box whose harvest is broken. When the webfree migration silently broke
-- the harvester (2026-06-07) every agent looked idle and the sweep had no way
-- to know its activity signal had gone blind.
--
-- WHAT
--   last_agent_activity_at -- newest non-cron message timestamp observed inside
--                             the agent's own state.db. Channel-agnostic: covers
--                             Telegram, Discord, standalone WebUI and TUI. Unlike
--                             instance_usage_snapshots (which keys on the day a
--                             SESSION STARTED) this tracks the last message
--                             EXCHANGED, so a long-lived Telegram thread opened a
--                             week ago and used daily still reads as active.
--   last_agent_probe_at    -- when the harvester last SUCCESSFULLY read that
--                             state.db. Presence of a fresh probe is what lets
--                             the sweep tell "confirmed idle" from "unknown".
--                             NULL / stale => the sweep must fail SAFE and not
--                             pause.
--
-- Both are written by the hourly /api/cron/harvest-agent-usage cron. They are
-- nullable with no backfill: until the harvester stamps a box, the sweep treats
-- its activity as UNKNOWN and leaves it alone. That is the intended, safe
-- rollout posture -- the fleet self-populates within one harvest cycle.

ALTER TABLE public.hermes_instances
  ADD COLUMN IF NOT EXISTS last_agent_activity_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_agent_probe_at TIMESTAMPTZ;

COMMENT ON COLUMN public.hermes_instances.last_agent_activity_at IS
  'Newest non-cron message timestamp seen in the agent''s own state.db (harvest-agent-usage). Channel-agnostic real-use signal; anchors the inactivity sweep alongside last_activity_at.';

COMMENT ON COLUMN public.hermes_instances.last_agent_probe_at IS
  'When harvest-agent-usage last SUCCESSFULLY read this agent''s state.db. NULL or stale => agent-side activity is UNKNOWN and the inactivity sweep must not pause the instance.';

-- The sweep scans lifecycle_state='active' rows by tier and idle cutoff, then
-- reads these two columns for the selected batch. The existing
-- (lifecycle_state, resource_tier, last_activity_at) access path is unchanged;
-- this partial index keeps the harvester's "who still needs a probe" style
-- lookups and any freshness auditing cheap without widening the hot path.
CREATE INDEX IF NOT EXISTS idx_hermes_instances_agent_probe_freshness
  ON public.hermes_instances (last_agent_probe_at)
  WHERE lifecycle_state = 'active';
