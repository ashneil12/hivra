-- Latest host capacity reading, written by the hivra-host-capacity cron when
-- HIVRA_HOST_CAPACITY_ALERTS is on. Placement reads it to skip a host whose
-- reading is critical. NULL means no reading: placement then behaves as before.
--
-- Idempotent: safe to run against a database that already has the columns.

alter table public.proxmox_hosts
  add column if not exists capacity_reading jsonb,
  add column if not exists capacity_reading_at timestamptz;

comment on column public.proxmox_hosts.capacity_reading is
  'Latest capacity reading from the hivra-host-capacity cron: level (ok, warn, critical), reasons, memory, disk pool and agent RAM totals. NULL until the first reading.';

comment on column public.proxmox_hosts.capacity_reading_at is
  'When capacity_reading was taken. Placement ignores a reading older than 15 minutes.';
