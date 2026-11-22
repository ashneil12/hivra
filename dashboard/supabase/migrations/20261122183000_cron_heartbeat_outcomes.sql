-- Honest cron heartbeats + customer-incident alerting support.
--
-- 1. ops_cron_heartbeats gains consecutive_failures + last_detail so a run
--    that completed but logged per-item failures is recorded as NOT ok:
--    run_count still bumps, ok_count and last_success_at do not move, and the
--    streak is countable ("the last N runs were not ok").
--
-- 2. record_cron_heartbeat() takes the run outcome. The old one-argument
--    signature is dropped and replaced by (text, boolean, text) with defaults,
--    so existing `record_cron_heartbeat('name')` callers keep working through
--    the new function's defaults.
--
-- Rerun-safe: IF NOT EXISTS / CREATE OR REPLACE / DROP IF EXISTS.

alter table public.ops_cron_heartbeats
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_detail text;

comment on column public.ops_cron_heartbeats.consecutive_failures is
  'Runs in a row that completed with per-item failures (ok=false). Reset to 0 '
  'by the next fully-ok run. The customer-incidents cron_unhealthy rule pages '
  'when this reaches 3.';
comment on column public.ops_cron_heartbeats.last_detail is
  'Short operator-facing reason the last run was recorded not-ok (counts only, '
  'no secrets). NULL after a fully-ok run.';

drop function if exists public.record_cron_heartbeat(text);

create or replace function public.record_cron_heartbeat(
  p_cron_name text,
  p_ok boolean default true,
  p_detail text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.ops_cron_heartbeats (
    cron_name, last_run_at, last_success_at, run_count, ok_count,
    consecutive_failures, last_detail, updated_at
  )
  values (
    p_cron_name,
    now(),
    case when p_ok then now() else null end,
    1,
    case when p_ok then 1 else 0 end,
    case when p_ok then 0 else 1 end,
    p_detail,
    now()
  )
  on conflict (cron_name) do update set
    last_run_at = now(),
    last_success_at = case
      when p_ok then now()
      else public.ops_cron_heartbeats.last_success_at
    end,
    run_count = public.ops_cron_heartbeats.run_count + 1,
    ok_count = public.ops_cron_heartbeats.ok_count + case when p_ok then 1 else 0 end,
    consecutive_failures = case
      when p_ok then 0
      else public.ops_cron_heartbeats.consecutive_failures + 1
    end,
    last_detail = p_detail,
    updated_at = now();
end;
$$;

-- Same posture as the one-argument version: service_role only.
revoke all on function public.record_cron_heartbeat(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.record_cron_heartbeat(text, boolean, text)
  to service_role;
