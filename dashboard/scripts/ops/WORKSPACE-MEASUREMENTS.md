# Collect workspace measurements before tiering

`workspace-measurements.py` is a standalone Linux collector. It doesn't start
or stop a sandbox, query a guest or database, change placement, persist an
archive, or install a schedule. Run it on the authorized host with a user that
can open the selected files with `O_NOATIME`; a synthetic directory owned by
the operator also works. Root paths must be absolute, canonical and
operator-controlled. The collector prints one JSON event to stdout for an
operator-managed, access-controlled ops log.

```sh
python3 dashboard/scripts/ops/workspace-measurements.py
python3 dashboard/scripts/ops/workspace-measurements.py --compression-samples 3
python3 dashboard/scripts/ops/workspace-measurements.py --gvisor-volumes-root /absolute/path/to/docker/volumes
```

The default scope reads the Classic backup mirrors under
`/var/lib/hermes-restic-src`. It counts both `webui-state` and
`webui-workspace` when present. These temporary staging trees are not the
enrolled fleet, aren't an inventory of all agent state, and can be incomplete
or change during collection. For gVisor, point the collector at the local
Docker daemon's volumes directory on the **sandbox host**; only workspace-shaped
volume names and their `_data` trees are read. This checks a local filesystem
scope, not Docker ownership labels, cohort membership, or sandbox state.
Neither scope should contain nested mounts. Don't add per-workspace paths,
identities, or tool stderr to downstream logs.

- Inventory counts separate discovered names, attempted workspaces, measured
  workspaces, missing components, and unusable trees. If
  `inventory_complete=false`, even the discovered count is a lower bound.
  An inaccessible or uncontacted host must stay unknown in a fleet rollup.
- Each successful scan reports apparent bytes (`st_size`), allocated bytes
  (`st_blocks * 512`) and unique inodes across its components, including
  directory metadata. It does not dereference symlinks or descend to a
  different filesystem. Nearest-rank p50/p90/p99/max are suppressed below
  three measurements. Do not average host percentiles into fleet percentiles.
- File age is measured from the newest regular-file mtime, which isn't the
  mirror sync age, a user's last activity, or proof of a restorable snapshot.
  An empty tree or a newest timestamp in the future gives no age sample.
  Authoritative freshness and restore-pack coverage stay null until there is
  authoritative sync or validated manifest evidence.
- The underlying filesystem's bytes and inodes available to unprivileged users
  and the maximum sampled host I/O full PSI avg10 are contextual measurements.
  They aren't a recovery floor, thin-pool headroom, or a capacity decision.
- Metadata-only is the default. Optional compression streams GNU
  `tar --sparse --atime-preserve=system` into single-threaded `zstd -1` and
  discards the compressed stream after counting bytes. It makes no archive or
  recovery claim. Only a successful whole pipeline counts. The apparent-byte
  ceiling is a preflight check; the filesystem is not snapshotted, so changes
  between or during passes can change the size.
- One collector at a time can scan a root. It runs at low CPU/idle I/O priority,
  stops at 1% full I/O PSI avg10 (or if PSI is unreadable), and has time,
  traversal-entry, workspace and compression-sample limits. Limits are checked
  between filesystem operations and during compression; kernel I/O stalls can
  delay exit. Compression samples come from the daily rotating workspace
  order and exclude over-limit trees. They're a bounded sample, not a
  representative estimate for the large tail.

## Optional activity observations

The collector doesn't infer activity from VM status, workspace mtimes or
Docker's running flag. `--activity-input /absolute/path/to/observations.json`
reads an optional, operator-owned regular file prepared by an authorized
read-only observation path. It must contain only the schema below, be at most
256 KiB, be owned by root or the collector user with no group or other
permissions, and scope its unique agent records to the same host and cohort.
Keep this input out of logs; identifiers only support in-memory deduplication
and don't appear in the emitted event.

```json
{
  "schema_version": 1,
  "scope": "classic_hermes_backup_mirror_proxy",
  "agents": [
    {
      "agent_id": "01234567-89ab-4cde-8f01-0123456789ab",
      "owner_hash": null,
      "reachable": true,
      "observed_at_unix_seconds": 1795794000,
      "last_used_at_unix_seconds": 1795793940
    }
  ],
  "aligned_run_count_snapshots": []
}
```

Use at most 512 cohort agents. Probe reachability and timestamps may be null.
Use a stable 64-character lowercase hex owner hash or null when the owner isn't
known. A valid use watermark from a reachable reading in the last 24 hours
contributes coverage. Only a watermark inside that window counts as observed
use. A recent watermark isn't proof of full 24-hour observation. Observed
owners are deduplicated, or null if any observed active owner is unknown.
Missing observations are unknown, not inactivity.

Use `aligned_run_count_snapshots: []` unless the source knows concurrently
observed counts at a shared instant. In that case provide up to 96 snapshots,
each containing a unique `observed_at_unix_seconds` and
`active_runs_by_agent`, in cohort order, with integers from 0 to 1024 and null
for agents not observed. Do not construct snapshots from staggered latest
readings or hourly activity sums. The reported peaks are the largest
**observed** totals for active runs and for agents with active runs across
snapshots in the window, with coverage at each peak. They aren't true fleet
peaks.

This collector doesn't supply the activity producer, an automated collection
job, or weeks of fleet evidence by itself.

## Focused checks

```sh
python3 -B -m unittest discover -s dashboard/scripts/ops -p test_workspace_measurements.py
```

GNU tar and zstd are needed for the real compression test. All tests use
synthetic temporary directories and observation files.
