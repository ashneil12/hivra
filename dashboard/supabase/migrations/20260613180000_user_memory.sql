-- user_memory — one account-level memory blob per Clerk user.
--
-- This is the "shared per-account memory" that lets a user's NEW Hivra agents
-- start warm: the user writes what every agent of theirs should know, and that
-- text is folded (read-only) into each fresh box's USER.md at bootstrap as a
-- `## Shared account memory` section. Each box still keeps its own evolving
-- USER.md afterwards — there is NO box→account write-back, so per-box isolation
-- is preserved (no contradiction with the "isolated by default" copy).
--
-- Written/read only by the service-role API route (/api/account/memory) via the
-- supabaseAdmin client, mirroring public.hivra_agents — NO row level security
-- and no anon/authenticated grants are added (the table has no PostgREST
-- exposure path; only the service role touches it). Idempotent: create-if-not-
-- exists throughout, so this is a no-op against an already-migrated DB.

create table if not exists public.user_memory (
  id         uuid        primary key default gen_random_uuid(),
  user_id    text        not null unique,
  content    text        not null default '',
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_user_memory_user_id
  on public.user_memory (user_id);

comment on table public.user_memory is
  'Account-level shared memory (one row per Clerk user). Read-only fanned out '
  'into new Hivra boxes'' USER.md at bootstrap as a "Shared account memory" '
  'section. No box write-back. Written by /api/account/memory (service role).';
