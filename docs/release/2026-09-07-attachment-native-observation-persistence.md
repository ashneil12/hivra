# Durable native observations

Local component PASS, based on `f4a2d78bf`. This extends the existing private
observation recorder and supplies an unregistered observation-only coordinator.
It does not enable attachment or claim useful-work readiness.

Additive migration `20260907010000_hivra_attachment_native_observations.sql`
replaces only the private observation RPC. Its prior ownership, source-first
locking, authority generation, exact saved activation, immutable replay,
atomic observation/outbox and denied mutation privileges are unchanged.
It adds `native_protocol_available` to the observation vocabulary with the
same required integer PID and observable journal-phase rules as process-running.
Existing generic observations cannot be promoted in place; neither state can
overwrite the other under the same observation ID. No runtime installation,
identity, binding or lease state is changed. These remain caller-supplied
observations, not independent guest attestation.

The store preserves the strict native result rather than flattening it into
generic process status, rejects ambiguous database confirmations, and sanitizes
serialization failures. `progressAttachmentNativeObservation` requires an
existing dispatched/staged activation, rereads authority before and after its
single native action, and records only a strictly parsed result with literal-true
persistence. Missing or changed state, lost replies and uncertain writes stay
held. A subsequent pass can observe again, never start or restart. Pending
deletion can retain diagnostic facts without release or new work.

Verification:

- The actual PostgreSQL fixture initially failed because the old RPC refused
  native observations. It passes with the additive migration.
- SQL covers exact replay, immutable conflicting replay, fresh-ID malformed
  state/PID/phase/identity refusal, wrong owner/stale authority, no rows/events
  on refusal, audit-write failure rollback, pending deletion and denied ACLs.
  Independent review improved malformed cases to use an unused ID so replay
  rejection could not mask missing payload validation.
- Full focused run: 29 tests, 3 suites, 4.633 seconds (activation coordinator,
  native bundle, activation host), plus TypeScript, touched-file lint and diff.
- Independent final review found no blocker and separately passed all 16
  coordinator/store tests with actual PGlite setup.
- Migration manifest regenerated to 305 entries. **Migration remains unapplied.**

No external resources, deployment, service-role grant, credential use or spending
occurred. Existing computers and data were untouched. Conservative cumulative
Hetzner reservation stays GBP 6.90/10. Local SQL state is discarded on fixture
close. Rollback before deployment removes the unregistered coordinator/store
extension and unapplied migration together; do not silently downgrade a deployed
reader after native observations exist.

Worker registration, migration/self-host/concurrency acceptance, binding
publication, detach/recovery and useful work through the normal UI remain open.
No full attachment or platform completion claim is made.
