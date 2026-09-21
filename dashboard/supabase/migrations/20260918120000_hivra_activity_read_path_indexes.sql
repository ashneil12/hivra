-- Per-user read-path indexes for the Activity surface's Hivra lane.
--
-- WHY
-- The Activity page previously read only the Hermes lane (hermes_instances +
-- instance_usage_snapshots), so a customer whose fleet is Hivra boxes saw
-- "No usage yet" while their real activity sat unread in hivra_agent_events.
-- The page now reads the Hivra lane too, per signed-in user, time-ordered:
--
--   select ... from hivra_agent_events
--     where user_id = $1 and created_at >= $2
--     order by created_at desc, id desc
--
-- hivra_agent_events already carries exactly the right index
-- (hivra_agent_events_user_idx, on (user_id, created_at desc)) — no change.
-- hivra_remote_desktop_sessions does NOT: it has only (computer_kind,
-- computer_id, expires_at desc) and a partial (session_token_hash) index, both
-- from its 2026-09-01 authority-role migration, so the new per-user scan
-- seq-scans. Invisible at today's ~230 rows; not at fleet scale.

-- Additive, idempotent, no data change, no policy change.
create index if not exists hivra_remote_desktop_sessions_user_idx
  on public.hivra_remote_desktop_sessions (user_id, created_at desc);

comment on index public.hivra_remote_desktop_sessions_user_idx is
  'Per-user time-ordered read path for the Activity surface (hivra lane).';
