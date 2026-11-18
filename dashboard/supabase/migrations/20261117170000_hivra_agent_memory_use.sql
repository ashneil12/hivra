-- Measured memory use per agent, without file cache, written by the
-- hivra-host-capacity cron when HIVRA_AGENT_MEMORY_SAMPLING=1. One row per
-- agent: the last sample and a peak per day for the last 14 days. Numbers only.
-- Service role only.
--
-- Additive and idempotent.

create table if not exists public.hivra_agent_memory_use (
  agent_id        uuid primary key references public.hivra_agents(id) on delete cascade,
  vmid            integer not null,
  total_mb        integer not null check (total_mb > 0),
  last_used_mb    integer not null check (last_used_mb >= 0),
  first_sample_at timestamptz not null,
  last_sample_at  timestamptz not null,
  days            jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now()
);

alter table public.hivra_agent_memory_use enable row level security;
-- No policies on purpose: only the service role (which bypasses RLS) reads or writes.
revoke all on public.hivra_agent_memory_use from anon, authenticated;

comment on table public.hivra_agent_memory_use is
  'Measured memory use per agent without file cache: the last sample and a daily peak for 14 days. Written by the hivra-host-capacity cron; numbers only.';
comment on column public.hivra_agent_memory_use.days is
  'Per UTC day: {"YYYY-MM-DD": {"peak": MB, "n": samples}}. Days older than 14 are dropped on write.';
