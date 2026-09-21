-- Launch-time managed-Venice opt-in for Hivra agents.
--
-- The deploy card lets the user choose to bill the agent's LLM usage to their
-- managed Venice wallet (catalog-gated; Aeon first). The choice is persisted
-- here so the post-provision connect step can default its toggle from what the
-- user picked at launch — connect is OFF by default otherwise.
--
-- Additive + idempotent (rerun-safe).

alter table public.hivra_agents
  add column if not exists managed_venice boolean not null default false;

comment on column public.hivra_agents.managed_venice is
  'User opted at launch to bill this agent''s LLM usage to their managed Venice wallet; the connect step defaults its wiring toggle from this.';
