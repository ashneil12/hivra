# One-pass activation coordinator and observation persistence — 2026-09-06

Source-only continuation from `9a48daef3`, PR #600. No route or worker is
registered. New migration `20260906235000_hivra_attachment_activation_observations.sql`
is **unapplied to Canary**, and all application mutation permissions remain
revoked. The generated migration manifest now contains 304 entries.

The coordinator reads the consistent owner-bound execution snapshot and existing
activation record. Historical attempts can only observe. A new attempt requires
a literal true database dispatch result in this pass, followed by a fresh
unchanged-authority snapshot, running intent and exact saved-grant confirmation
before its single start. A lost grant/start response cannot become another start
on the next pass. State is re-read before observation, including pending-delete
intent. Strict guest results feed private observation persistence; there are no
retry loops, native-readiness claims, binding publication or lease-release calls.

The private SQL observation gate locks the source first, rechecks its held
attachment operation, owner, provider authority and canonical generation, and
binds every result to the saved activation/installation/boot/unit digest. It
appends an observation and audit event atomically. Exact observation-ID replays
preserve the original row; conflicting replays are refused. Pending deletion may
record observations but cannot activate or unlock. `service_inactive` remains
only a service-state observation, not process/socket/session release proof.

## Checks

- The actual PGlite lease/migration harness passed with the new migration. Added
  cases exercise wrong owner/generation/authority, mismatched request and result,
  invalid phase/PID/readiness, audit-event rollback, exact and conflicting replay,
  pending-delete observations, occupied lifecycle authority and denied mutation
  access for anon/authenticated/service roles.
- Three focused Jest suites: **25 tests passed in 4.180s**, using the actual SQL
  activation and newly persisted observation as fixtures. Coordinator tests cover
  fresh grant order, historical observation, false/truthy/lost grants, lost start
  response recovery, changed/delete state after grant, malformed observations and
  ambiguous persistence. Host execution was mocked.
- Full TypeScript, touched-file ESLint and diff checks passed. Independent
  bounded review found no P1/P2, independently passed the actual PGlite harness
  and all 11 coordinator/store tests, and checked the diff.

Migration SHA-256:
`69b9cbe9e24b756869cc92a707a1a7549dd980e20c20a1a2dc413cd02a8410ed`.
Status: PASS for these source/database-fixture checks, not live-integrated
acceptance. Real concurrent-worker cancellation fencing and live coordinator
execution are not proved by sequential mocks. No VM, retained computer, live
database, deployment, provider purchase or model work changed. No additional
spend or temporary live resources. The isolated PGlite fixture closes on exit.

Next are native-protocol readiness, binding publication and the reviewed worker
cutover; normal UI attachment and useful authorized model work remain required.
Detach/recovery, Windows/Omarchy gates and the full core-experience goal remain
open. Rollback is to leave these unregistered components and the new migration
unused; no live rollback was needed.
