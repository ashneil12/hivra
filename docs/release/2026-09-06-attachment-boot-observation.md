# Attachment pre-dispatch boot binding — 2026-09-06

Scope: source-only private attachment dispatch/guest boundary, baseline
`704edab5c`. No Canary migration/deployment, retained-computer mutation, model
inference or spending.

## Change

The guest result parser required an independent expected boot, but the database
did not persist that observation and the worker previously checked boot only
when replaying its own journal. That was incomplete target behavior: a guest
reboot between observation and execution could only be detected after staging.

`20260906220000_hivra_attachment_guest_observation.sql` adds a private immutable-
through-application-roles observation row tied to the operation, boot and reviewed
worker digest. Its private RPC requires the exact owner, generation, guest
authority, installation reservation, running shared lease and relationship
controller. Source-first locking matches cancellation/reservation/dispatch.
Exact replay is read-only, including after dispatch; boot replacement is refused.

The dispatch transition now requires an observation no older than five minutes
and not in the future. Replay never renews it. A stale undispatched operation
must be explicitly cancelled and a new one admitted. No lease is automatically
released; older dispatched operations receive no invented boot identity.

The worker requires `--expected-boot-id` and compares it to the actual Linux
boot before creating/checking staging directories or executing the installer.
Its new SHA-256 is `2a0aee3e5e3fc0d4403d41a93dbece648648c8a84ab4349a71d7fe87243121ab`;
the TypeScript pin and SQL drift regression match. The original stager bytes
remain unchanged.

## Evidence

- Actual PostgreSQL migration/lease fixture plus guest-result contract:
  **2 suites / 22 tests PASS, 1.431s**. Cases include missing installation/boot,
  wrong owner/generation/authority/worker pin, null and changed boot, cancelled
  operation, stale/future timestamps, unchanged replay timestamp, one-time
  dispatch, atomic dispatch failure and application-role mutation/RPC denial.
- Updated real Linux worker suite: **9 tests PASS, 3.727s**. Pinned Codex staging
  and nonexecuting replay still pass. The new negative case injects a different,
  invalid or null expected boot and forbids even the directory setup call.
- ESLint on changed TypeScript, Node syntax on SQL fixture, and diff checks pass.
  Migration manifest regenerated: 300 entries.

Linux fixture: container
`e4f9e70d23ca03e5697ff97ecd01d3d5be2f37e8a061c5cf1b6dfee7a1e2c6cc`,
owner `00000000-0000-4000-8000-000000001074`, existing image
`sha256:d3870c1312a28311a89f2fa8e4419985be477df4d09e9c4d8a02841c212600b8`,
Linux amd64 emulation, network none, no host mounts/ports, 768 MiB, one CPU,
64 PID limit, 300-second deadline. Stager/archive root ownership was set inside
the disposable container only. Exact label/mounts inspected before stop;
container and anonymous volume
`39aacd14c578281b64e21e9a2e0e182e857b56f2f4f87c504d86a1eb77471571`
were absent on post-stop inventory. No owned process or fixture remains.

Migration SHA-256: `5b574f98ae0a6e65620db464e207507b1f23a935cdcc05cabce95b76cc51568e`.

## Limits

The host observer/executor is not connected yet. A private database caller must
obtain boot from the exact bound guest; the RPC is not remote attestation. No
actual VM reboot, SSH observer loss, concurrent PostgreSQL boot-observation
race, UI attachment, readiness, detach or database lease release is claimed.
This is not full attachment acceptance. Rollback before deployment is a source
revert; no live rollback was needed or exercised.

Decision: **PASS for the source-only boot binding**. Independent reviewer Pauli
found no actionable P1/P2, independently passed the actual SQL fixture and 41
parser tests, and checked both pins. Their additional coverage suggestion was
implemented: a transaction-local legacy-dispatched fixture with its observation
removed cannot acquire a new observation, then rolls back. Final combined run
passes **3 suites / 42 tests, 1.379s**. SQL and worker source did not change after
review. Full live attachment acceptance remains open.
