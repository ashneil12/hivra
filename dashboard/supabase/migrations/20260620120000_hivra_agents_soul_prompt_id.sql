-- hivra_agents — persona-souls upgrade (full authored SOUL.md per persona).
--
-- Additive + idempotent. Records which authored persona soul prompt
-- (persona-souls.json / getPersonaSoul: bea | sloane | pike | marlo | sable |
-- lane) the user picked at onboarding. When set, the box's SOUL.md is seeded with
-- the FULL prompt instead of the generic identity template.
--
-- Nullable: existing rows, the custom "Build your own" persona, and any launch
-- that skips persona selection all leave this NULL — the bootstrap seeder then
-- falls back to the generic SOUL.md template exactly as before (zero-regression).

alter table public.hivra_agents add column if not exists soul_prompt_id text;

comment on column public.hivra_agents.soul_prompt_id is
  'Persona-soul id (persona-souls.json key) chosen at onboarding; NULL = generic SOUL.md template.';
