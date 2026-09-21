-- Atomic forward_auth use counter for per-stream HMAC tokens.
--
-- Replaces the SELECT-then-UPDATE increment in
-- src/lib/agent-stream-token-uses.ts, which had a read-modify-write race:
-- N concurrent forward_auth calls for the same stream_id could all read the
-- same consumption_count and all write back the same +1, letting more than
-- the cap slip through (a leaked signed URL fanned out across many concurrent
-- clients — exactly the attack the cap exists to bound). supabase-js can't
-- express `consumption_count = consumption_count + 1` in an UPSERT, so the
-- increment lived in the app layer and was non-atomic.
--
-- This does the insert-or-increment in ONE statement. Postgres serializes
-- concurrent calls on the conflicting row, so each gets a distinct count.
-- consumption_count defaults to 1 on first insert (the table default) and
-- increments by exactly 1 on every subsequent call, returning the new value.
--
-- Rerun-safe: create-or-replace; no data migration.

create or replace function public.record_agent_stream_token_use(
  p_stream_id text,
  p_instance_id text,
  p_expires_at timestamptz,
  p_now timestamptz default now()
)
returns integer
language sql
security definer
set search_path = public
as $$
  insert into public.agent_stream_token_uses
    (stream_id, instance_id, expires_at, first_consumed_at, last_consumed_at, consumption_count)
  values
    (p_stream_id, p_instance_id, p_expires_at, p_now, p_now, 1)
  on conflict (stream_id) do update
    set consumption_count = public.agent_stream_token_uses.consumption_count + 1,
        last_consumed_at = excluded.last_consumed_at,
        expires_at = excluded.expires_at
  returning consumption_count;
$$;

revoke all on function public.record_agent_stream_token_use(
  text,
  text,
  timestamptz,
  timestamptz
) from public;

grant execute on function public.record_agent_stream_token_use(
  text,
  text,
  timestamptz,
  timestamptz
) to service_role;

comment on function public.record_agent_stream_token_use(
  text,
  text,
  timestamptz,
  timestamptz
) is
  'Atomically insert-or-increment the forward_auth use counter for a per-stream HMAC token and return the new consumption_count. Replaces a racy SELECT-then-UPDATE in the app layer (see src/lib/agent-stream-token-uses.ts).';
