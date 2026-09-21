# Durable attachment staging coordinator — 2026-09-06

Source milestone from `8cdb4e883`, high-risk attachment orchestration scope.
No Canary deployment, migration application, worker/route registration or live
host dispatch. No retained computer changed and no additional money spent.

Migration `20260906233000_hivra_attachment_execution_snapshot.sql` adds one
consistent owner-bound read of the active held command, current guest/controller
authority, reserved installation, saved boot, dispatch and recorded result.
It grants only this read to service_role; all attachment mutation RPCs remain
private. SHA-256:
`a759ff9b70d27bc337bc101622def12de1613153ff7fc3164f939897d74baf0e`.
Generated manifest now lists 302 migrations; pending migrations remain unapplied.

The strict snapshot parser checks owner, phase consistency, source binding,
runtime pins, canonical decimal bigint generation and any saved staging receipt.
The store adapter requires explicit data/error fields, literal error null and
literal boolean mutation confirmation. Raw failures are not exposed.

One coordinator pass reserves installation/binding IDs, persists an independently
observed boot, fetches the pinned archive, wins the one-time dispatch CAS, stages
once and records the receipt. Reservation/boot rereads cannot adopt changed
authority. Only a literal true CAS acknowledgement in that pass permits stage.
An existing dispatch enters read-only observe, including after a lost CAS
acknowledgement; missing/incomplete guest state cannot trigger reinstall.
Already recorded results return staging_recorded without host execution, not
runtime-ready. Pending deletion prevents new claimed work but allows receipt
recovery. Failures stay held without retries, activation, cancellation or release.

## Evidence and limits

Actual isolated SQL fixture exercises admission, dispatch, result persistence,
owner exclusion, cancelled-command exclusion and ACLs. Its claimed/dispatched/
pending-delete staged JSON outputs feed the TypeScript parser in the coordinator
tests. The fixture confirms anon/authenticated cannot call the new reader and
anon/authenticated/service_role still cannot invoke mutations. PGlite closes in
finally; no Docker/VM/provider resources were created by this milestone.

Focused checks cover CAS ordering, ambiguous/false/lost acknowledgements,
observe-only recovery, exact-once local stage calls, each prerequisite failure,
wrong-owner state, authority drift, strict RPC replies and retained result state.
Host execution is mocked here; prior Linux transport/installer receipts are
separate evidence, not live end-to-end acceptance for this coordinator.
Final checks: **5 suites / 79 tests PASS, 2.342s**, scoped ESLint, full
`tsc --noEmit --incremental false` and diff check PASS. Independent review:
GREEN, no concrete P1/P2; reviewer independently passed 2 suites / 20 tests
including the actual SQL snapshots and role denials, checked the migration hash
and reread the final generation/failure guards. Scoped source milestone: PASS.
The SQL exercise is sequential, not a concurrency test. No live acceptance or
permission activation is implied by this result.

Stale pre-dispatch boot observations remain held until explicit cancellation and
a new operation; the coordinator does not refresh them. Actual durable worker
registration and permission activation must follow service/access activation,
terminal evidence, detach/recovery and route authorization work. Short HTTP
requests are not the execution environment for the long stage deadline. Normal
Canary UI acceptance remains open. Rollback is a source revert before deployment;
no live rollback was needed.
