# Durable attachment installation IDs — 2026-09-06

Source-only checkpoint on `codex/hivra-core-experience-plan`, baseline
`25347d1d3`. Migration `20260906210000_hivra_attachment_installation_reservation.sql`:
SHA-256 `88b29512ae5821bbbbdbfa6df978df9a252f2dde91c6ecfe32ff5562ffc3eac6`.

The private reservation command records installation/binding UUIDs, architecture
and reviewed stager hash for an exact owned attachment command/generation before
dispatch. It uses source-first locking consistent with dispatch/cancellation,
requires the held claimed lease and canonical authority, and rejects existing
runtime/binding IDs. Unique reservation IDs cannot be reused by another command.
Exact repeats remain harmless after dispatch; IDs/architecture cannot be replaced.
No canonical runtime or active binding is created by this reservation.

A database trigger rejects a transition to dispatched without the reserved
installation matching the intended stager. Older already-dispatched records are
not retroactively given invented installation IDs; their held lease remains and
must be reconciled explicitly. No application-role execution or table write grant
is added, and the existing dispatcher still grants at most one transition.

## Evidence

The regression failed before the new migration: dispatch succeeded with no
installation reservation. With the migration, the same call is rejected with
55000. The actual PGlite attachment fixture additionally proves owner/generation
and architecture rejection, exact replay, replacement refusal, retired-runtime
ID preservation, cross-command reservation uniqueness, no fabricated runtime
rows, post-dispatch replay and private ACLs. Existing dispatch rollback and
lifecycle protections continue to pass.

From `dashboard/`:

```sh
npm test -- --runInBand --runTestsByPath src/__tests__/hivra-attachment-lease-postgres.test.ts src/lib/agent-computers/__tests__/attachment-staging-receipt.test.ts src/__tests__/hivra-canonical-authority-postgres.test.ts
npx eslint src/lib/agent-computers/__tests__/attachment-staging-receipt.test.ts
node --check scripts/test-hivra-attachment-lease.cjs
```

Three suites/23 tests pass, plus lint, script syntax and diff checks. The source
pin test also checks the reservation migration contains the reviewed stager
digest. Manifest generation now includes 299 migration files. These remain
sequential subset-schema SQL fixtures, not concurrent guest execution or full
self-host migration acceptance.
Independent reviewer Pauli reviewed the unchanged migration digest, ran the
attachment SQL fixture and returned scoped GREEN. The final direct collision
assertions above were added and run locally after that review; they did not
change the reviewed SQL.

No deployment, live migration, guest action or spending occurred. Isolated
PGlite state closes after tests; no new external resource was created. Source
rollback is a reviewed revert; no live rollback was needed. Worker reservation
lookup, bound transport/observation, terminal handling, runtime service/access
and live attachment acceptance remain unfinished.
