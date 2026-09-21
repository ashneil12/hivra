-- hivra_agent_events — append-only telemetry for Hivra agent lifecycle (Phase 0 observability).
--
-- Lets later phases of the Hivra V1 rebuild prove behaviour from data, not vibes
-- (launch success rate, provision latency, failure reasons, resize activity).
--
-- Additive + idempotent. No FK to hivra_agents on purpose: this is an audit log, so a
-- deleted agent's events must survive, and `launch_requested` fires before the agent row
-- exists (agent_id is therefore nullable).

create table if not exists public.hivra_agent_events (
  id         uuid        primary key default gen_random_uuid(),
  agent_id   uuid,
  user_id    text        not null,
  event      text        not null,   -- launch_requested | provisioned | failed | resized | stopped | started | restarted | deleted
  agent_type text,
  detail     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists hivra_agent_events_agent_idx
  on public.hivra_agent_events using btree (agent_id, created_at desc);

create index if not exists hivra_agent_events_user_idx
  on public.hivra_agent_events using btree (user_id, created_at desc);
