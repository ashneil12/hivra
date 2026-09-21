-- instance_metering_events — append-only per-instance resource samples.
--
-- Sprint 0 W3 of the HermesOS V2 launch. The dashboard's compute billing
-- pipeline (compute_usage_events + vm_response_seconds_daily) tracks
-- "agent thinking time" for tier caps and credit debits, but it does NOT
-- capture the underlying Hetzner-billable signals (CPU seconds, RAM peak,
-- disk used, runtime hours, outbound bandwidth) per VM. Without those
-- signals we cannot reconcile our customer-facing metering against the
-- Hetzner host bill within the 5% tolerance the build plan calls for.
--
-- This table is the raw sample stream. A cron (`/api/cron/sample-instance-
-- metrics`) hits the Proxmox host on every tick, pulls qm-status / rrddata
-- for each active VM, and writes one row per (instance, sample). A future
-- billing reconciliation sprint sums these rows against the per-host
-- Hetzner invoice; this sprint only collects, it does not bill.
--
-- Why a separate table from vm_response_seconds_daily:
--   * Different shape: that table is one hot row per (instance, day) with
--     UPSERTs, owned by warden. This table is append-only sample events,
--     owned by the dashboard cron — different write pattern, different
--     contention story.
--   * Different signal: warden measures wallclock-of-stream from the host
--     Caddy log. This table measures host-resource consumption from
--     Proxmox itself (the only reliable source for CPU seconds and net out).
--
-- RLS: same shape as the rest of the user-owned tables in this codebase.
-- Users can SELECT their own samples (joined via hermes_instances.user_id
-- with the JWT claim resolved by public.requesting_user_id()). Service
-- role manages all writes.

create table if not exists public.instance_metering_events (
  id uuid primary key default gen_random_uuid(),
  instance_id uuid not null references public.hermes_instances(id) on delete cascade,
  sampled_at timestamptz not null default now(),
  cpu_seconds_total numeric not null default 0,
  ram_peak_bytes bigint not null default 0,
  disk_used_bytes bigint not null default 0,
  runtime_seconds numeric not null default 0,
  net_out_bytes bigint not null default 0,
  source text not null default 'proxmox',
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists instance_metering_events_instance_sampled_idx
  on public.instance_metering_events(instance_id, sampled_at desc);

alter table public.instance_metering_events enable row level security;

drop policy if exists "users can read own metering" on public.instance_metering_events;
create policy "users can read own metering"
  on public.instance_metering_events
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.hermes_instances i
      where i.id = instance_metering_events.instance_id
        and i.user_id = public.requesting_user_id()
    )
  );

drop policy if exists "service role manages metering" on public.instance_metering_events;
create policy "service role manages metering"
  on public.instance_metering_events
  for all
  to service_role
  using (true)
  with check (true);

revoke all on public.instance_metering_events from anon;

comment on table public.instance_metering_events is
  'Append-only per-instance resource samples (CPU seconds, RAM peak, disk used, runtime seconds, outbound bytes) collected on a regular cadence. Sourced from Proxmox host. Read by future billing reconciliation against Hetzner invoice. Written exclusively by service role via /api/cron/sample-instance-metrics.';
comment on column public.instance_metering_events.cpu_seconds_total is
  'Cumulative CPU seconds consumed by the VM since boot, as reported by Proxmox. Deltas across rows give per-tick CPU usage.';
comment on column public.instance_metering_events.ram_peak_bytes is
  'Peak RAM (bytes) observed at sample time. Not cumulative across rows; treat each row as a point sample.';
comment on column public.instance_metering_events.disk_used_bytes is
  'Disk usage (bytes) reported at sample time. Treat as point sample.';
comment on column public.instance_metering_events.runtime_seconds is
  'VM uptime (seconds) at sample time. Deltas across rows give wall-clock runtime accumulated between ticks.';
comment on column public.instance_metering_events.net_out_bytes is
  'Cumulative outbound bytes since VM boot, as reported by Proxmox. Deltas across rows give per-tick egress.';
comment on column public.instance_metering_events.source is
  'Origin of the sample. Currently only "proxmox"; reserved for future "warden", "hetzner_api", etc.';
