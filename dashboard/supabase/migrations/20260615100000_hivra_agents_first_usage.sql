-- Durable first-use activation stamp for Hivra boxes.
--
-- Hermes-lane agents already have hermes_instances.first_usage_at stamped by the
-- usage harvester. Hivra boxes only had a browser-local localStorage marker from
-- HivraChat, which means activation disappeared across devices / cleared storage
-- and could not be queried server-side. This column gives the Hivra lane the
-- same write-once durable activation signal.

alter table public.hivra_agents
  add column if not exists first_usage_at timestamptz;

comment on column public.hivra_agents.first_usage_at is
  'First successful user message observed for this Hivra box. Write-once activation signal stamped by /api/hivra/agents/[id]/first-usage; localStorage remains only an instant UI fallback.';
