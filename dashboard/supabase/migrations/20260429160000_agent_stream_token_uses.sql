-- agent_stream_token_uses — replay-protection ledger for the per-stream
-- HMAC tokens emitted by /api/instances/[id]/chat-start and verified by
-- /api/internal/agent-stream-auth (the Caddy forward_auth handler).
--
-- Pre-migration risk: a leaked signed URL was replayable from anywhere
-- until its exp (default 600s). The HMAC alone proves "the URL came from
-- our dashboard" but not "this is the legitimate browser that requested
-- it" — anyone with the URL gets the per-instance bearer back. Browser
-- screenshots, copy-paste, or proxy logs that captured the URL would
-- have given the holder ~10 minutes of read access on the in-progress
-- chat.
--
-- This table caps how many forward_auth calls a single token can satisfy
-- inside its TTL. We allow > 1 because legitimate browsers reconnect
-- (EventSource auto-reconnect, service worker take-over, brief network
-- blips) — but a small ceiling stops fan-out attacks (one leaked URL
-- being opened from N attacker IPs).
--
-- Service-role only: clients never read or write this table directly.
-- The forward_auth handler uses an UPSERT-and-RETURN pattern to atomic-
-- ally increment consumption_count and reject when it exceeds the cap.
-- See src/lib/agent-stream-token-uses.ts for the implementation.

create table if not exists public.agent_stream_token_uses (
  stream_id text primary key,
  instance_id text not null,
  first_consumed_at timestamptz not null default now(),
  last_consumed_at timestamptz not null default now(),
  consumption_count integer not null default 1,
  expires_at timestamptz not null
);

-- Index for the cleanup sweep (DELETE WHERE expires_at < now() - grace).
create index if not exists agent_stream_token_uses_expires_idx
  on public.agent_stream_token_uses(expires_at);

alter table public.agent_stream_token_uses enable row level security;

drop policy if exists "service role manages stream token uses"
  on public.agent_stream_token_uses;
create policy "service role manages stream token uses"
  on public.agent_stream_token_uses
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.agent_stream_token_uses from anon, authenticated;

comment on table public.agent_stream_token_uses is
  'Replay-protection ledger for per-stream HMAC tokens (forward_auth). One row per stream_id, with a consumption_count that caps how many times the same signed URL can be redeemed inside its TTL. Written exclusively by service role from /api/internal/agent-stream-auth.';
comment on column public.agent_stream_token_uses.consumption_count is
  'Total forward_auth verifications against this stream_id. Rejected when it exceeds AGENT_STREAM_MAX_PARALLEL_USES (configurable; default 5). Allows legitimate browser reconnects without unblocking attacker fan-out.';
comment on column public.agent_stream_token_uses.expires_at is
  'When the underlying HMAC token stops being valid. After this point the row is eligible for cleanup; we keep it briefly so a slow replay still hits "too_many_uses" instead of starting fresh.';
