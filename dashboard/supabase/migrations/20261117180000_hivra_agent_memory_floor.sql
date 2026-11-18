-- The memory floor last set on an agent's VM by the hivra-memory-floors cron
-- (HIVRA_AGENT_MEMORY_FLOORS). NULL means none was ever set: the VM keeps its
-- full memory as its floor.
--
-- Additive and idempotent.

alter table public.hivra_agent_memory_use
  add column if not exists floor_mb integer check (floor_mb is null or floor_mb > 0),
  add column if not exists floor_set_at timestamptz;

comment on column public.hivra_agent_memory_use.floor_mb is
  'The memory floor (VM balloon minimum, MB) last set by the hivra-memory-floors cron. NULL: never set, the VM keeps its full memory.';
