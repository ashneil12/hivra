# Managed Linux Sandbox shared storage pilot

This is an internal Canary procedure, not an availability claim. It supports
one handoff of one explicitly enrolled QA sandbox to one pinned, compatible
target. It retains the source's fenced local copy until teardown. It does not
offer arbitrary placement, repeat moves, production eviction, source storage
reclamation, a model reply SLO, or a lazy restore.

## Bound the fixture

- Use a synthetic workspace and two dedicated QA guests on distinct owned
  hosts. Record their VMIDs, exclusive storage and CPU/memory envelopes,
  connector and target revisions, runtime identities, and cleanup deadline.
  Do not reuse a customer host's Docker runtime, connection, or backup namespace.
- Prepare both targets with the same exact reviewable adapter and runsc
  identities and a pinned local image. Require the existing fixed-backed XFS
  project-quotas policy for each guest, including Docker and containerd
  persistence, byte and inode floors and physical backing evidence. The
  workspace hard caps allocate blocks as written. The hot admission budget
  still covers writable volumes' remaining maxima; a verified fenced and
  stopped source no longer adds an unspendable growth commitment. Its used
  space remains counted until authorized teardown.
- Provision a fixture-scoped SFTP credential and existing Storage Box
  directory, with strict endpoint host-key verification and no access to
  backup directories. Use only an already authorized restricted route from
  the QA guests; do not change shared forwarding as part of this procedure.
  Verify dev-only cleanup permissions separately from fixture credentials.
- On each guest, install the reviewed `hivra-gvisor-tier-handoff.py` and
  `hivra-gvisor-generation.py` as `handoff.py` and `generation.py` under
  `/opt/hivra/gvisor-adapter/tier`, root-owned, directory mode 0700 and
  file modes 0600. Supply root-owned mode 0600 `storage-known-hosts` and
  `storage-key` there. The host system Python needs distribution packages
  `python3-cryptography` and `python3-paramiko`. Use `qa-storage.json` in the
  same root with version 1, `host`, `port`, `user`, `directory`, `scratch`,
  `scratchReserveBytes`, `maxBytes`, `maxEntries` and
  `maxCiphertextBytes`. Scratch must be a canonical root-private directory on
  dedicated, reserved local space. It may briefly contain an authenticated
  plaintext spool; it must not be a shared mount. Do not run the host adapter
  with shell tracing or print the credential files or command stdin.

## Arm in Canary only

Apply the reviewed additive handoff migration to Canary before the exact Git
build ships. Check object bodies and service-only execution permissions. Use
the normal managed-gVisor expiring QA enrollment for the source, keep general
launch off, and require managed disk admission. Sign into the standing QA
tenant and launch the tagged fixture on the source normally. Keep the
destination preflight fresh. Pin the returned exact computer UUID and the
destination connection, target and revision in:

- `HIVRA_MANAGED_GVISOR_TIER_COMPUTER_ID`
- `HIVRA_MANAGED_GVISOR_TIER_DESTINATION_CONNECTION_ID`
- `HIVRA_MANAGED_GVISOR_TIER_DESTINATION_TARGET_ID`
- `HIVRA_MANAGED_GVISOR_TIER_DESTINATION_CONNECTION_REVISION`
- `HIVRA_MANAGED_GVISOR_TIER_HELPER_SHA256` and
  `HIVRA_MANAGED_GVISOR_TIER_CODEC_SHA256`, from the installed reviewed files
- `HIVRA_MANAGED_GVISOR_TIER_KEY`, a dedicated random 32-byte server secret,
  hex-encoded, never copied to either host or the Storage Box
- `HIVRA_MANAGED_GVISOR_TIER_ENABLED=true`, for the canonical Canary Git
  deployment only

The environment is captured at build time. Verify the exact Git deployment
that sees the settings; do not assume an existing deployment picks them up.
The ledger pins the first operation's expiry and both placements. The server
derives a one-generation key from the QA master and sends only that derived
key as SSH stdin to each authenticated host. Keep the master and pinned
settings until the fixture is retired, including if the cohort has expired.
Expiry blocks read/write dispatch; the same exact QA identity can still
Destroy its fixture without reopening it.

## Accept and tear down

1. In the normal terminal, write and hash a deterministic synthetic marker.
   In Overview choose **Sleep to shared storage**. Verify the source session
   was stopped, its fence is durable, and readback of the encrypted canonical
   generation was accepted before the ledger says sleeping. A failed
   checkpoint never frees the local copy. **Verify checkpoint again** reuses
   the same identity; it never opens an alternate writer.
2. For the first wake, submit a command from the same normal terminal. The
   command should read the marker after destination XFS admission, verified
   archive restore, runsc health and routing commit. Repeat a distinct request
   and verify both reached the same destination without restoring over
   newly written files. A partition or uncertain receipt must never permit
   a different target or reopen the source.
3. Before considering automation or reclamation, exercise failed upload,
   lost receipt, wrong key, corrupted ciphertext, low disk/inodes, SSH loss
   during restore, and destination retry with an unreachable source. Use
   dedicated synthetic fixtures. A failed restore must not accept a terminal
   writer. Check the actual running commands and route rather than only SQL.
4. Record the protected identity-free browser flow as MP4 and retain exact
   Canary deployment evidence. Use a monotonic client timer to first useful
   command result; the anonymous ops fields separately measure host restore
   and server command return when info-level application logging is enabled.
   Report counts, p50/p95/p99, archive sizes,
   consecutive and burst behavior, failures, and the host-unavailable result.
   Five repeats or an SSH-only result are not service acceptance. The target
   is p95 ≤10 seconds for the measured typical pack, with no hot-path
   regression. Wakes are serialized per host; this pilot does not promise
   fair or durable global request queues.
5. Only after manual acceptance, use a fresh explicitly enrolled fixture
   before staging `HIVRA_MANAGED_GVISOR_TIER_AUTO_ENABLED=true` and a per-plan
   `HIVRA_MANAGED_GVISOR_TIER_IDLE_HOURS` JSON map. A missing or invalid plan
   threshold, absent command activity, held command, or recent start cannot
   qualify. Use synthetic, one-shot commands that do not leave background
   work; this version does not establish idle authority for any workload with
   persistent tasks, sessions or direct connectors.
6. Use the normal **Destroy** confirmation for each exact enrolled QA
   fixture. Retirement holds routing first and releases the slot and target
   only on exact absence receipts from both hosts. Verify the deleted
   tombstone and both hosts' resource inventories. Then remove only the
   run-owned Storage Box prefix, host fences with the dedicated guests,
   temporary connectivity, credentials and settings. Verify absence before
   releasing the standing tenant. Never clear a fence to work around an
   unconfirmed checkpoint or retirement.

No customer reclamation or wider rollout is part of this pilot. The archive
supports regular files, directories, and internal hardlinks and symlinks.
Metadata such as extended attributes and sparse allocation is not a pilot
contract. Treat unsupported entries as a failed checkpoint, not as
permission to remove the local copy.
