# Private attachment dispatch — 2026-09-06

Source-only milestone on `codex/hivra-core-experience-plan`, baseline
`5c6bcd7fb`. Migration `20260906200000_hivra_attachment_dispatch.sql`, SHA-256
`ef0e8b43996215586e7d9f3de8a492efb3a635b90bdace5db14fdb0dbc554e29`.

The database-owner-only dispatch function checks exact owner, operation,
relationship generation, guest authority and installer digest. It locks the
original lifecycle source before canonical rows and checks the current
projection, infrastructure readiness and absence of conflicting relationships.
The claimed-to-dispatched transition and dispatch audit record commit together.
The active reservation indexes and row guard now cover both phases.

Repeated dispatch never returns another grant. Cancellation can only release an
undispatched claim; pending deletion prevents dispatch and cannot steal a
dispatched slot. Generic release/recovery cannot clear or refresh the held lease.
These are database transition semantics, not an exactly-once guest execution
claim. No worker, installer, terminal evidence or reconciliation is implemented
by this migration. No service-role or browser execution grant is added.

## Verification and limits

The existing isolated PGlite attachment fixture now applies this actual migration
after the real legacy lifecycle/canonical migration subset. Before implementation
it failed on the absent dispatch function. It now verifies wrong owner, stale
generation, wrong guest identity, wrong installer digest, pending deletion,
cancelled command rejection, one successful transition, repeat rejection,
dispatched replay, cancellation refusal, retained delete intent and generic
recovery refusal. An injected audit insertion failure rolls phase and dispatch
fields back to claimed. Private dispatch records cannot be deleted by application
roles. A fresh second database computer is used instead of resurrecting the
earlier deleting fixture.

From `dashboard/`:

```sh
npm test -- --runInBand --runTestsByPath src/__tests__/hivra-attachment-lease-postgres.test.ts src/__tests__/hivra-canonical-authority-postgres.test.ts src/lib/agent-computers/__tests__/relationship-reader.test.ts
```

Three suites/eight tests pass. Migration manifest generation includes 298 files;
diff checks pass. The fixture remains sequential SQL with representative
Hermes/pool/channel columns, not concurrent PostgreSQL sessions, full self-host
schema, guest execution or browser acceptance. Cancellation-vs-dispatch lock
contention, lost network acknowledgements and real worker fencing remain gates.

Independent reviewer Pauli returned scoped GREEN on the digest above after
checking the dispatch transition, retained lease guards, rollback and private
ACLs and independently running the updated SQL fixture. This does not replace
the remaining concurrent-worker or live acceptance gates.

No deployment, live migration, guest action, model request or provider spend
occurred. PGlite closes in `finally`; no external resources were created.
Rollback is a reviewed source revert, not a demonstrated rollback over live
dispatched work. The full core and attachment acceptance remain open.
