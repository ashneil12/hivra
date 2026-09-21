-- Retire the signed-URL SSE chat lane's replay-protection ledger.
--
-- The lane (signed stream URL → Caddy forward_auth →
-- /api/internal/agent-stream-auth) is dead end-to-end: chat runs over the
-- sidecar WS bridge, the token-minting/verification code and the
-- forward_auth route are deleted in the same change, and the box-side
-- /api/chat/start + /api/chat/stream endpoints the lane fronted answer
-- 405/404 on current images. Nothing reads or writes this table any more.
--
-- Apply AFTER the code deploy (not apply-ahead): the prune cron in the
-- previous deploy still deletes expired rows from this table once a day.
--
-- The function references the table, so drop the function first.

drop function if exists public.record_agent_stream_token_use(
  text,
  text,
  timestamptz,
  timestamptz
);

drop table if exists public.agent_stream_token_uses;
