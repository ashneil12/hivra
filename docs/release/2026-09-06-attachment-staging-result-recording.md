# Attachment staging result recording — 2026-09-06

Scope: private source-only database recording boundary, based on `d26a68d35`.
No deployment, Canary migration, guest mutation, model inference or spending.

`20260906230000_hivra_attachment_staging_result.sql` adds a result record linked
to both the durable dispatch and pre-dispatch guest observation. Its private RPC
requires the exact owner, operation, authority generation, bound guest authority,
observed boot, reserved installation/binding, and current relationship controller.
It acquires the same source-first lock as admission/dispatch/cancellation.

The entire envelope and nested receipt are checked in SQL, not merely trusted
because a TypeScript parser exists: exact keys/identities, `staged` state,
version, runtime, architecture-specific archive/binary digests, private account
and paths, and bounded non-root numeric UID/GID. Primitive or missing receipts,
unknown fields and oversized results fail closed. Exact replay returns success
without replacing bytes or timestamp; a different valid result cannot overwrite
the original observation.

Pending deletion may still record evidence for reconciliation, but this function
does not activate an agent, create canonical entities, change the operation phase,
or release the shared lifecycle lease. Application roles have no write or execute
grant. The trusted bound observer must supply the independently observed boot;
this RPC is not transport authentication or remote attestation.

## Evidence

Actual PostgreSQL migration/lease fixture plus both TypeScript result parsers:
**3 suites / 42 tests PASS, 1.338s**. SQL cases include wrong owner/generation/
guest authority/boot, cancelled command, each mismatched outer identity field,
malformed primitive/array receipts, unknown fields, invalid UID/GID types/ranges,
wrong pins/paths, exact replay and conflicting-result refusal. After recording,
all three canonical relationship inventories remain empty, phase remains
`dispatched`, the source operation ID remains held, and generic release fails.
The SQL fixture closes its isolated PGlite database in `finally`.

Artifact-pin drift test, ESLint, Node syntax and diff checks pass. Manifest
regenerated with 301 migrations. Migration SHA-256:
`f537e63b0aa3a71f37123a7e8064a3dbabdf582041853b40177e714c27c759b8`.

## Limits and rollback

No actual host worker calls this RPC yet; service/access setup, activation,
recovery/detach and normal UI acceptance remain unimplemented. These SQL tests
use synthetic guest results, not live transport evidence or concurrent SQL
result-writer proof. All attachment migrations remain unapplied to Canary.
Rollback is a source revert before deployment; no live rollback or resource
cleanup was needed. Full core/attachment completion is not claimed.

Decision: **PASS for the private source recording boundary**. Independent
reviewer Pauli found no actionable P1/P2 at the migration digest above, and
independently passed the actual SQL fixture, 41 parser/pin tests and diff check.
This is not live attachment or lifecycle-release acceptance.
