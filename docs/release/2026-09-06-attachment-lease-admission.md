# Attachment lease admission — 2026-09-06

Source-only checkpoint on `codex/hivra-core-experience-plan`, baseline
`80094052d`. Migration `20260906190000_hivra_attachment_lease.sql`, SHA-256
`eae102c8eb09f98239ed6f9ecdc10ced785922086c9d9c951ad1c2a86457423e`.

This implements private admission and undispatched cancellation, not runtime
attachment. Both commands are denied to service-role and browser roles. No
dispatch/completion RPC, worker or installer is enabled. A digest in the intent
is a binding to proposed installer bytes, not acceptance of those bytes.

The command verifies the original Computer mapping, canonical relationship
generation, running/idle Ubuntu Proxmox source and exact infrastructure identity.
It reserves the same lifecycle slot used by existing operations, stores an
immutable-by-application intent and an outbox event atomically, and returns only
exact command/intent replays. It creates no agent identity or runtime record.
Existing identities, active bindings and non-removed installations are rejected
rather than silently migrated or overwritten. Initial runtime scope is Codex;
that restriction does not establish a working Codex attachment adapter.

The lease guard prevents changed guest identity, operation replacement, generic
release/recovery timestamp changes and status mutation while claimed. Delete intent may become pending but
cannot be withdrawn or steal the lease. Undispatched cancellation releases the
slot while preserving pending delete. There is no time-based takeover.

## Verification

From `dashboard/`:

```sh
node scripts/test-hivra-attachment-lease.cjs
npm test -- --runInBand --runTestsByPath src/__tests__/hivra-attachment-lease-postgres.test.ts src/__tests__/hivra-canonical-authority-postgres.test.ts src/lib/agent-computers/__tests__/relationship-reader.test.ts
node scripts/test-hivra-desktop-prepare.cjs
npx eslint src/__tests__/hivra-attachment-lease-postgres.test.ts
```

The focused suites pass (three suites/eight tests), as do standalone SQL checks,
wrapper lint and diff checks. Manifest generation includes 297 migrations.
The new test originally failed on the absent admission function before its
implementation. Fixture setup first needed the independent nullable pool column;
this was fixture coverage, not a production migration defect.

The isolated PGlite fixture executes actual legacy Hivra lifecycle migrations
alongside the canonical migrations and the new migration. It proves exact replay,
owner/generation/guest identity rejection, restart-first exclusion, all ordinary
lifecycle claim kinds blocked while attachment holds the slot, pending deletion,
hard-delete rejection, safe cancellation, outbox-failure atomic rollback and
private command/table ACLs. It also admits and cancels an existing desktop
preparation after the new migration and rejects competing attachment.

The combined fixture exposed a real compatibility defect: the original canonical
operation mapper returned null for newer operation kinds even when an operation
ID existed, violating the canonical row constraint and leaving preparation
events unprocessed. The additive replacement preserves an unknown-but-occupied
state and exact operation ID for newer kinds. Admission requires a fully
processed, current source payload and no pending source events; that gate was
kept, not removed to make tests pass. Regression checks prove no pending events
and the exact attachment operation in the canonical row. The actual generic
recovery RPC is also rejected when it attempts to refresh the reserved timestamp.

The fixture uses representative Hermes columns and independent pool/channel
columns; it is not the full billing/self-host schema. Tests use sequential SQL
transactions, not independent concurrent sessions, guest processes or public
browser authentication. Dispatch races, lost acknowledgements, terminal receipts,
stale completion and self-host recovery remain explicit next gates.
Independent reviewer Pauli inspected the private command scope, identified the
projection/recovery compatibility gaps, and returned scoped GREEN after their
correction and a fresh run of the complete attachment SQL fixture on the digest
above. This review does not close the outstanding live/concurrency gates.

## Preservation and remaining work

No live migrations, guest operations, provider purchases or model calls occurred.
PGlite closes in `finally`; retained resources and data are untouched. Rollback
is a reviewed source revert; no live rollback was required or exercised.
Attachment, domain migration and full core acceptance remain open. This staged
command must not receive application execution grants before safe dispatch,
terminal reconciliation, the non-destructive installer and their gates exist.
