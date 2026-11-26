# Proxmox health probe timing

The existing gateway health sweep can retain a per-host timing snapshot in the
`probe-instance-health` row of `ops_cron_heartbeats.last_detail`. This is off
unless an operator configures `HERMES_PVE_PROBE_TIMING_HOSTS` with an
allowlist of managed Proxmox node slugs, for example `pve-a,pve-b`.
The first 16 valid list entries are considered.
The deployment must already have the outcome-aware heartbeat migration.

The snapshot contains its probe window, attempt and failure counts, and a
disjoint histogram of reachable response times in milliseconds. Bounds are
inclusive and the last bucket is overflow. A host needs at least three
observations in that sweep to appear. An empty snapshot or absent host is
missing data, not a healthy result.

These timings are for the existing unauthenticated gateway probe as observed by
the dashboard. A reachable 4xx still counts as reachable; an initially failed
probe is counted as failed even if existing recovery logic later finds a
reachable alternate. This is not customer request latency or wake-to-ready
latency. Use the explicit window when matching the snapshot to host counters,
and don't estimate a tail from scant observations.

The heartbeat keeps only the latest snapshot. Use an authorized read-only
collection path if you need history. No new probe, monitoring service, public
response field, or storage reservation is created by this option.
