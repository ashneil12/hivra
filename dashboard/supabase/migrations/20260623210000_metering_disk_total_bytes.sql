-- instance_metering_events.disk_total_bytes — the guest filesystem's REAL total
-- size (df / "1B-blocks"), captured alongside disk_used_bytes.
--
-- Why: the Layer A storage-usage banner computed "how full is the disk" as
-- disk_used_bytes / (hermes_instances.disk_size_gb * 1024^3). But disk_size_gb
-- is a thin-provisioning RESERVATION hint used by the allocator — it routinely
-- drifts from the VM's actual disk (e.g. an 800G thin disk recorded as 40),
-- which produced impossible >100% banners ("198% of its disk") on agents that
-- were in fact nearly empty.
--
-- The metering sampler already measures the guest's real `df /` total and used
-- bytes over SSH, but only `disk_used_bytes` was persisted. This column persists
-- the matching total so the banner can divide a real numerator by a real
-- denominator from the SAME measurement. NULL means the sample was not
-- guest-sourced (SSH/guest-agent unavailable); the banner shows nothing rather
-- than guessing against a stale reservation size.

alter table public.instance_metering_events
  add column if not exists disk_total_bytes bigint;

comment on column public.instance_metering_events.disk_total_bytes is
  'Guest filesystem total size in bytes from `df /` at sample time (the real disk the agent sees). NULL when the sample was not guest-sourced. The storage-usage banner divides disk_used_bytes by THIS — never by the thin-provisioned hermes_instances.disk_size_gb reservation, which drifts from the actual disk.';
