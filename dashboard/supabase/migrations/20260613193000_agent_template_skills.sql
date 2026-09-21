-- agent templates — carry an agent's installed SKILLS so a fork reproduces them
-- (Wave 5.2 follow-up). v0 left skills out because they live as box-side files,
-- not a hivra_agents column. This adds the snapshot + replay plumbing.
--
-- DESIGN (catalog-referencing snapshot): a template stores a jsonb ARRAY of
-- CURATED-CATALOG skill IDS (src/data/curated-skills.ts), never the skill bodies.
--   * The id list is the only way to reproduce THIS agent's deliberate skill
--     choices; a pure "the type implies a default set" reference cannot.
--   * The catalog stays the content source — re-seeding pulls each SKILL.md from
--     the catalog (installCuratedSkillsOnBox), so no skill markdown lands in the
--     DB (small, versioned with the dashboard, and safe to SHARE since an id is
--     non-sensitive — unlike the free-text `context`, the skill ids are carried
--     to non-owners on shared templates rather than stripped).
--   * Bankr-suite skills are EXCLUDED from the snapshot — they're auto-seeded onto
--     every CLI box (maybeSeedBankrSkills), so carrying them would be redundant.
--   * User-AUTHORED (non-catalog) skills are out of v0 of this follow-up: their
--     content is user-typed/sensitive (can't survive a public share) and would
--     need a per-file content read at snapshot time. Left for a later iteration.
--
-- REPLAY: a launch from a template copies the template's skill ids onto the new
-- hivra_agents row (template_skills); the GET-poll bootstrap then SSH-seeds them
-- onto the box exactly once (guarded by template_skills_seeded_at), mirroring the
-- Bankr seed (bankr_skills_seeded_at). NULL guard = not yet (retry on poll).
--
-- Additive + idempotent: add-column-if-not-exists throughout, so this is a no-op
-- against an already-migrated DB.

-- The snapshot: curated skill ids this template reproduces on a fork.
alter table public.agent_templates
  add column if not exists skills jsonb;

comment on column public.agent_templates.skills is
  'Curated-catalog skill ids (src/data/curated-skills.ts) the source agent had '
  'installed at save time — the deliberate, non-Bankr additions. A jsonb string '
  'array; never skill bodies. Carried to non-owners on shared templates (ids are '
  'non-sensitive). Re-seeded onto a fork via installCuratedSkillsOnBox.';

-- The replay: skill ids carried from the template onto a launched agent, plus a
-- one-time seed guard (mirrors bankr_skills_seeded_at).
alter table public.hivra_agents
  add column if not exists template_skills jsonb;

alter table public.hivra_agents
  add column if not exists template_skills_seeded_at timestamptz;

comment on column public.hivra_agents.template_skills is
  'Curated skill ids carried from the template this agent was forked from. A jsonb '
  'string array, snapshotted at launch so bootstrap can seed them without re-reading '
  'the (possibly deleted) template. NULL/empty = not a template fork or no skills.';

comment on column public.hivra_agents.template_skills_seeded_at is
  'When template_skills were SSH-seeded onto the box. NULL = not yet (retry on '
  'poll); only set for CLI boxes (codex/claude-code) that carried template skills.';
