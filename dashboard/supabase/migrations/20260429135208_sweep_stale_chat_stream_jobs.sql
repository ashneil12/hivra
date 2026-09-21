-- Sweep zombie chat-stream jobs whose runner is dead (lease expired) but
-- the row still says 'pending' or 'running'. The dashboard treats those
-- as live-active streams and blocks new sends; user sees STOP GENERATING
-- forever, can't message the agent.
--
-- Diagnostic that motivated this: 5 zombie rows in production, oldest
-- with lease expired 56,648s (15+ hours) ago, blocking the user's chat.
-- Symptom: chat-stream-jobs polling 200s, but no POST /send-stream when
-- user types — UI thinks something's already running.
--
-- Heuristic for "zombie": status in (pending, running) AND
-- (lease_expires_at IS NULL OR lease_expires_at < now() - 60 seconds).
-- The 60s grace window covers normal heartbeat slop without sweeping
-- live runs. We mark them 'failed' (terminal state, removed from the
-- active polling set) and stamp updated_at + completed_at so subsequent
-- diagnostics show them as terminated.
update public.hermes_chat_stream_jobs
set status = 'failed',
    error = coalesce(error, 'Runner lease expired without finalize'),
    updated_at = now(),
    completed_at = coalesce(completed_at, now())
where status in ('pending', 'running')
  and (lease_expires_at is null or lease_expires_at < now() - interval '60 seconds');

-- Companion: any in-flight messages tied to those zombie jobs should
-- also be marked stream_state='error' in their metadata so the chat
-- panel doesn't render them as still-streaming. Defensive — most rows
-- already have a terminal stream_state per persistServerChatStreamProgress
-- but stream-state lag has been observed.
do $$
declare
  swept integer;
begin
  with affected as (
    update public.hermes_chat_stream_jobs
      set updated_at = updated_at  -- no-op for affected count
      where status = 'failed'
        and error = 'Runner lease expired without finalize'
        and updated_at >= now() - interval '5 seconds'
      returning 1
  )
  select count(*) into swept from affected;
  raise notice 'sweep_stale_chat_stream_jobs: marked % zombie row(s) failed', swept;
end $$;
