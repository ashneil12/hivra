-- hivra_agents — agent bootstrap (first-conversation identity + onboarding).
--
-- Additive + idempotent. Captures the onboarding the user gives at launch (goal +
-- free-text context) plus the default-with-veto identity (name already exists;
-- personality + emoji are new), and a one-time `bootstrapped_at` guard so the box
-- gets its SOUL.md / USER.md / first-conversation prompt seeded exactly once.
--
-- All nullable: existing rows (and launches that skip onboarding) are unaffected —
-- the bootstrap seeder derives a sensible identity from the agent name alone.

alter table public.hivra_agents add column if not exists goal            text;
alter table public.hivra_agents add column if not exists context         text;
alter table public.hivra_agents add column if not exists personality     text;
alter table public.hivra_agents add column if not exists emoji           text;
alter table public.hivra_agents add column if not exists bootstrapped_at timestamptz;

comment on column public.hivra_agents.goal is 'Onboarding goal id (agent-identity.ts GoalId) — what this agent is for.';
comment on column public.hivra_agents.context is 'Free-text onboarding context the user gave at launch (seeded into USER.md).';
comment on column public.hivra_agents.personality is 'Agent personality (default-with-veto; derived from goal unless overridden).';
comment on column public.hivra_agents.emoji is 'Agent signature emoji (default-with-veto; derived from goal unless overridden).';
comment on column public.hivra_agents.bootstrapped_at is 'When SOUL.md/USER.md/prompt were seeded onto the box. NULL = not yet (retry on poll).';
