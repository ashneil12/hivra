-- agent_templates — save / share / fork a configured agent as a named, reusable
-- template (Wave 5.2, STICKINESS_PLAN.md). The only network-effect + creator-
-- economy lever in the plan: a user snapshots a configured agent's PORTABLE
-- identity into a named, one-click-launchable template and (optionally) shares
-- it (private → link → public).
--
-- What a template carries (the portable identity of a hivra_agents row):
--   type, name, goal, context, personality, emoji, llm_config (jsonb, key-free).
-- It NEVER carries the encrypted LLM key (llm_api_key_encrypted) or any per-agent
-- minted proxy-key fields — those are re-minted at launch. On link/public share
-- the free-text `context` is STRIPPED before the template leaves the owner (it's
-- user-typed and possibly sensitive); private templates keep it (owner's own).
--
-- Skills are intentionally OUT of v0 scope — they're box-side files, not a
-- hivra_agents column, so there's nothing to snapshot here yet (follow-up).
--
-- Written/read only by the service-role API routes (/api/hivra/templates*) via
-- the supabaseAdmin client, mirroring public.hivra_agents — NO row level security
-- and no anon/authenticated grants (the table has no PostgREST exposure path;
-- only the service role touches it). Idempotent: create-if-not-exists throughout,
-- so this is a no-op against an already-migrated DB.

create table if not exists public.agent_templates (
  id            uuid        primary key default gen_random_uuid(),
  owner_user_id text        not null,
  slug          text        not null unique,
  source        text        not null default 'community',
  type          text        not null,
  name          text,
  goal          text,
  context       text,
  personality   text,
  emoji         text,
  llm_config    jsonb,
  visibility    text        not null default 'private',
  share_token   text        unique,
  forked_from   uuid        references public.agent_templates(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint agent_templates_visibility_check
    check (visibility in ('private', 'link', 'public')),
  constraint agent_templates_source_check
    check (source in ('builtin', 'community'))
);

create index if not exists idx_agent_templates_owner_user_id
  on public.agent_templates (owner_user_id);

create index if not exists idx_agent_templates_share_token
  on public.agent_templates (share_token);

comment on table public.agent_templates is
  'Saved/shared/forked agent templates (Wave 5.2). Snapshots the PORTABLE '
  'identity of a hivra_agents row (type, name, goal, context, personality, '
  'emoji, llm_config) — never the encrypted LLM key. context is stripped on '
  'link/public share. Written by /api/hivra/templates* (service role only).';
