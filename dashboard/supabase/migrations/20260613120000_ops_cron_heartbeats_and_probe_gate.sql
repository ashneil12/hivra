-- Cron dead-man heartbeats.
--
-- One row per critical cron. Each cron stamps last_run_at + last_success_at
-- (and bumps run_count/ok_count) at the END of a successful run via the
-- record_cron_heartbeat() RPC. The check-cron-heartbeats watchdog (hosted in
-- /api/cron/migration-drift-check) reads this table and emits a fatal ops
-- event for any registered cron whose last_success_at is older than 2x its
-- expected period — turning a silent Vercel-Cron failure (500, timeout, or
-- de-scheduled) into a page instead of an invisible gap.
--
-- Rerun-safe: every object guarded with IF NOT EXISTS / CREATE OR REPLACE.

create table if not exists public.ops_cron_heartbeats (
  cron_name text primary key,
  last_run_at timestamptz,
  last_success_at timestamptz,
  run_count bigint not null default 0,
  ok_count bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.ops_cron_heartbeats is
  'Dead-man heartbeats for critical crons. record_cron_heartbeat() stamps a '
  'successful run; the watchdog in /api/cron/migration-drift-check pages when '
  'last_success_at is older than 2x the cron period.';

-- Upsert + increment in one round-trip. SECURITY DEFINER so the admin client
-- (and only it — see the RLS lockout below) can write without a per-call grant
-- dance. record_count and ok_count both bump on a successful run because we
-- only call this on the success path; if a cron's run/ok diverge later we can
-- split the call, but the registry today only records wins.
create or replace function public.record_cron_heartbeat(p_cron_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ops_cron_heartbeats (cron_name, last_run_at, last_success_at, run_count, ok_count, updated_at)
  values (p_cron_name, now(), now(), 1, 1, now())
  on conflict (cron_name) do update set
    last_run_at = now(),
    last_success_at = now(),
    run_count = public.ops_cron_heartbeats.run_count + 1,
    ok_count = public.ops_cron_heartbeats.ok_count + 1,
    updated_at = now();
end;
$$;

-- Service-role only: written by crons via the admin client, read by the
-- watchdog via the admin client. Lock out anon/authenticated like the other
-- ops tables (lifecycle_email_sends, ops_events policy posture).
alter table public.ops_cron_heartbeats enable row level security;
revoke all on public.ops_cron_heartbeats from anon;
revoke all on public.ops_cron_heartbeats from authenticated;
revoke all on function public.record_cron_heartbeat(text) from anon;
revoke all on function public.record_cron_heartbeat(text) from authenticated;

-- ── Prober consecutive-failure gate ──────────────────────────────────────
--
-- The synthetic instance-health prober used to run ~495 probes via Promise.all
-- in one Vercel invocation with a 6s timeout, so ~83% of "failures" were the
-- prober's own AbortError under load — it cried wolf. The fix bounds probe
-- concurrency, raises the per-probe timeout, AND requires N>=2 consecutive
-- failing ticks before OPENING a generic synthetic.instance-health event. This
-- tiny per-instance counter is that gate's state: bumped on a failing tick,
-- reset to 0 on a healthy tick. Keyed on instance_id so it survives across the
-- 5-minute prober ticks (an in-memory counter would reset every invocation).
create table if not exists public.instance_health_probe_state (
  instance_id text primary key,
  consecutive_failures integer not null default 0,
  last_failure_at timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.instance_health_probe_state is
  'Per-instance consecutive-failure counter for the synthetic health prober. '
  'Gates generic synthetic.instance-health events behind N>=2 failing ticks so '
  'a single AbortError under prober load cannot open a false outage.';

alter table public.instance_health_probe_state enable row level security;
revoke all on public.instance_health_probe_state from anon;
revoke all on public.instance_health_probe_state from authenticated;
