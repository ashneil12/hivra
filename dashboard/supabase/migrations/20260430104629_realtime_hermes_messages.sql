-- Enable Postgres logical replication for hermes_messages so the dashboard
-- can subscribe to inserts/updates over the supabase_realtime channel.
-- This unlocks the architecture where the per-instance sidecar daemon
-- writes new messages (from any source — dashboard, Telegram, Discord,
-- direct agent API) to the mirror, and connected dashboards see them
-- pushed in within ~1s without polling. See the 2026-04-30 mirror-sync
-- design discussion for the full rationale; without realtime here the
-- daemon is just feeding a static cache.
--
-- RLS on hermes_messages already restricts visibility per user, and
-- supabase_realtime respects RLS — a user's WebSocket subscription only
-- emits rows their session can SELECT. So this is purely the publish
-- side; nothing changes about who can see what.
--
-- REPLICA IDENTITY FULL ensures UPDATEs include the full prior row
-- payload in the logical replication stream, which realtime needs to
-- emit a usable change event for diff/merge on the client.
--
-- Idempotent: discovered on first apply that hermes_messages was
-- already a member of supabase_realtime (the publication is created
-- by Supabase platform setup and our table happened to land inside
-- it via earlier migrations). Wrap the publication add in a guard so
-- replays don't 42710 on the duplicate-membership error.

ALTER TABLE public.hermes_messages REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'hermes_messages'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.hermes_messages;
  END IF;
END $$;
