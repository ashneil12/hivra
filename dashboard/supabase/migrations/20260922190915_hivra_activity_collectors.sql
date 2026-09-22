-- Per-computer state of the guest agent-run reporter (Activity "native tracing").
--
-- WHY
-- Claude Code and Codex computers now run a guest reporter that sends
-- content-free run/tool records plus a heartbeat every 5 minutes. Heartbeats
-- must not become hivra_agent_events rows (288 per computer per day would
-- crowd real history out of the Activity read window), and Activity needs to
-- tell "reporting", "waiting for first report", "stopped reporting" and
-- "credential expired" apart. One row per computer holds that state.
--
-- Contract: docs/superpowers/specs/2026-09-22-agent-run-tracing-contract.md
--
-- Written only by the service role (launch/start issuance, ingest, renewal).
-- RLS enabled with no policies, matching hivra_agent_events.

create table if not exists public.hivra_activity_collectors (
  agent_id uuid primary key references public.hivra_agents (id) on delete cascade,
  user_id text not null,
  issued_at timestamptz,
  credential_expires_at timestamptz,
  issue_reason text check (issue_reason in ('launch', 'start', 'renew')),
  last_heartbeat_at timestamptz,
  last_event_at timestamptz,
  last_rejected_at timestamptz,
  last_rejected_reason text check (last_rejected_reason in ('expired', 'clock_skew')),
  last_install_status text check (last_install_status in ('installed', 'failed')),
  last_install_reason text check (last_install_reason ~ '^[a-z_]{1,40}$'),
  last_install_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists hivra_activity_collectors_user_idx
  on public.hivra_activity_collectors (user_id);

alter table public.hivra_activity_collectors enable row level security;

comment on table public.hivra_activity_collectors is
  'Guest agent-run reporter state per Hivra computer; service role only.';
