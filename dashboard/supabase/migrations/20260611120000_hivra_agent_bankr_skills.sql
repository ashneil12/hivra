-- hivra_agents — one-time guard for seeding the curated Bankr skill suite onto a box.
--
-- Additive + idempotent. The Hermes lane preinstalls the Bankr skills at launch
-- (instance-service.ts → /api/skills/save); a Hivra CLI box has no such write
-- endpoint, so the dashboard SSH-writes the skill files into the box's per-CLI
-- skills dir on the first poll after it goes running, then stamps this column so
-- it only happens once (retry on next poll if the SSH write fails). NULL = not
-- yet seeded. Only CLI boxes that expose a skills dir (codex / claude-code) are
-- ever seeded; other agent types leave this NULL forever (never attempted).

alter table public.hivra_agents add column if not exists bankr_skills_seeded_at timestamptz;

comment on column public.hivra_agents.bankr_skills_seeded_at is
  'When the curated Bankr skill suite was SSH-seeded onto the box. NULL = not yet (retry on poll); only set for CLI boxes (codex/claude-code).';
