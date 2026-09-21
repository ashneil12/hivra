-- Pull-loop foundation: queryable goal / first_task columns (both lanes).
--
-- The lifecycle-email personalization, the day-1 standing task, and the
-- auto-execute-first-task turn all need the user's captured goal + first task
-- as QUERYABLE columns (today firstTask is folded into hivra_agents.context,
-- and on the Hermes lane goal/context/firstTask live only inside the agent
-- systemPrompt prose — not queryable by the cron/sweep).
--
-- Hivra lane: goal + context already exist (20260606120000); add first_task.
-- Hermes lane: add goal + first_task + context (none exist today).
-- All additive + nullable + idempotent. Existing rows unaffected.

-- Hivra lane (hivra_agents.goal / .context already present)
alter table public.hivra_agents add column if not exists first_task text;

comment on column public.hivra_agents.first_task is
  'Captured "first task to demonstrate value" — queryable for auto-execute + lifecycle email personalization.';

-- Hermes lane (hermes_instances had these only inside the systemPrompt)
alter table public.hermes_instances add column if not exists goal       text;
alter table public.hermes_instances add column if not exists first_task text;
alter table public.hermes_instances add column if not exists context    text;

comment on column public.hermes_instances.goal is
  'Onboarding goal id (agent-identity GoalId) captured at launch — queryable for pull-loop personalization.';
comment on column public.hermes_instances.first_task is
  'Captured "first task to demonstrate value" for the Hermes lane (write-threaded in Wave 1).';
comment on column public.hermes_instances.context is
  'Free-text onboarding context captured at launch (Hermes lane), mirrored from the welcome systemPrompt.';
