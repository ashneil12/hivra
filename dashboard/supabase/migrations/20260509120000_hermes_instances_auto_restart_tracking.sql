-- The recover-stuck-instances cron currently only flips rows from
-- failed/provisioning to running when /health responds 200 OK. For rows
-- where the gateway is genuinely unreachable (agent crashed, container
-- exited, OOM kill, etc.) the cron does nothing — the user has to click
-- "Start agent" manually, which is what support tickets keep reporting
-- ("agent keeps dropping into error state and requires a manual restart").
--
-- To enable an automatic restart attempt without risking infinite
-- restart loops on rows that crash on every boot, track when the last
-- auto-restart fired and how many consecutive attempts we've made.
-- The cron resets attempts to 0 on a successful health probe (the row
-- recovered) and stops attempting once the cap is hit.

alter table public.hermes_instances
  add column if not exists last_auto_restart_at timestamptz;

alter table public.hermes_instances
  add column if not exists auto_restart_attempts integer not null default 0;

comment on column public.hermes_instances.last_auto_restart_at is
  'Timestamp of the last auto-restart attempt fired by the '
  'recover-stuck-instances cron. NULL means no auto-restart has been '
  'attempted on this row. Used together with auto_restart_attempts to '
  'rate-limit restart attempts.';

comment on column public.hermes_instances.auto_restart_attempts is
  'Consecutive auto-restart attempts since the last successful health '
  'probe. Reset to 0 when the cron promotes the row to running, '
  'incremented on each restart attempt. The cron stops attempting once '
  'this hits the cap so a row that crashes on every boot does not get '
  'restarted forever.';
