# Private attachment activation dispatch — 2026-09-06

Source-only checkpoint after `b6e19c709`. No Canary migration, guest service,
permission grant, route, deployment, capacity purchase or model request occurred.
The existing weekend resource/spend ledger is unchanged; no test VM was created.

## Change and authority

The verified service definition previously had no durable one-time service-start
admission. This is unimplemented target behavior, not a reproduced live bug.
Migration `20260906234000_hivra_attachment_activation_dispatch.sql` adds a private
activation-dispatch record and audit outbox. Both are written in one transaction.
All application-role mutation and RPC execution privileges remain revoked;
service_role receives only table reads and the owner-scoped read RPC. The
attachment's existing `agent_attach` lease remains occupied and its phase stays
`dispatched`. No identity, installation, binding or ready state is created.

Dispatch locks the original source first, checks its exact owner, held operation,
payload, running desired/observed state, guest authority and binding readiness,
then checks current canonical projection/event and relationship generation.
It requires the recorded staging result, reservation, dispatch and boot to match
exactly. A competing canonical runtime/binding/identity or pending delete refuses
the request. A second call returns false even with the same activation ID;
lost acknowledgement is not permission to issue another start. Audit failure
rolls back the grant. Reading the record never renews or redispatches it.

The request binds the reviewed service-builder policy hash
`66f89162530b682aa66d8a59250f385530726a162def8902ffb7bc953eee9428` and a generated
unit digest. The SQL boundary validates the policy pin and digest format; it
does **not** reconstruct systemd content or inspect guest bytes. The internal
TypeScript adapter derives the unit digest from the exact staged receipt and
committed builder, and validates saved records against the same expectation.
The future pinned guest activation worker must independently verify unit bytes,
actual account/installation/boot, and execution ownership before starting.

The adapter snapshots inputs before async RPCs, sends no caller-supplied commands
or unit content, accepts only literal boolean confirmations and sanitizes errors.
Pending delete can read prior dispatch evidence for eventual reconciliation but
cannot build a new activation request. No application caller uses this adapter.

## Evidence

The new SQL expectation failed before the function existed. After implementation,
the actual PGlite PostgreSQL harness passed missing-stage, wrong-owner/operation/
generation/authority/boot/result/policy, malformed digest, stale projection,
competing runtime, audit rollback, replay, pending delete and role-denial checks.
Existing staging/lease coverage and its three snapshot outputs remain present.
The isolated database is closed in `finally`; it is not the live Canary database.

Four focused Jest suites passed **28 tests in 4.025 seconds**, including:

- Actual SQL activation output parsed against the committed service builder.
- Exact private RPC arguments and true/false distinction.
- Foreign/stale/malformed record rejection and no truthy-response grants.
- Input snapshotting across asynchronous dispatch and reads.
- Existing staging coordinator, native-service and SQL lease contracts.

Changed TypeScript lint, full `tsc --noEmit`, and diff checks passed. The generated
migration manifest contains 303 entries. Independent reviewer Pauli found no
P1/P2 defect and independently ran three suites / 26 tests, including the actual
SQL cross-contract fixture. Policy-source and migration hashes matched; review
retained the sequential, no-guest-worker and SQL-digest-format-only limits.
Migration SHA-256:
`67c6471f7ff69066bacc40f0f9080b0a676aa48b37e280b6e8335aa321d27bb0`.

## Limits and next step

This is sequential SQL transaction evidence, not simultaneous-worker contention,
real network-loss, guest activation, useful model work or browser attachment
acceptance. The previous real systemd campaign remains separately recorded; it
did not execute this new database gate. The guest activation worker, observed
readiness/result recording, authority-aware binding publication, detach/release,
reboot/recovery semantics and product routing remain open. Do not apply the
pending migration chain or enable mutation roles simply to expose this slice.
`UC-ATTACH-AGENT-01` and the full core-experience goal remain open.
