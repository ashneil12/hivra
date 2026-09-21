# Read-only activation observation and payload assembly — 2026-09-06

Source-only continuation from `e5f013985`, PR #600. This adds missing internal
components; it does not repair a reproduced live incident or enable Attach Agent.
The previous actual Ubuntu starter campaign remains separate evidence.

The observer pins the reviewed starter/preflight, validates the original request
and current guest boot, and opens only the existing activation root, lock and
journal. It takes a nonblocking shared lock, checks strict journal shape and
request equality, and retains root/lock/journal metadata and exact bytes through
observation. For start-requested/started attempts it checks the journal's unit
inode, exact definition, loaded policy and current process identity, rechecking
the original state before returning. It creates no state and sends only systemd
show queries; it never starts, stops, repairs or resets an operation.

Results distinguish `process_running`, `service_inactive` and
`activation_unresolved`. A lost acknowledgement can be observed without a second
start. Preparing/failed attempts stay unresolved. Inactive is not proof that
descendants, sockets, sessions or authority have been released. None of these
results establishes native readiness, useful model work or a new dispatch grant.
Missing, mismatched, busy, changed or old-boot evidence fails closed.

The pure TypeScript payload builder validates and snapshots the existing SQL
execution/activation records, pins/copies five bounded guest assets and assembles
the exact nested start or observation packet. Pending deletion may observe but
cannot build a start packet. The builder itself grants no dispatch authority;
there is no registered host/application caller or newly granted DB privilege.

## Verification and cleanup

- Actual pinned staging/preflight in a root Linux amd64 disposable Docker
  fixture: **10 tests passed in 20.794s**. Systemd and process observations were
  simulated. Tests cover read-only opens, lost acknowledgement, inactive and
  unresolved states, missing state, busy lock, changed journal/unit, mismatched
  PID/request and unreviewed/duplicate-field input.
- Two focused Jest suites: **11 tests passed in 3.032s**, including actual SQL
  fixture records decoded by the Python packet/policy code, invalid input before
  asset reads, pending deletion and changed/oversized source refusal.
- TypeScript, touched-file ESLint and diff checks passed.
- Independent bounded source reviews found no P1/P2. The observer's parser,
  dependency pin, AST and diff were checked independently; the assembler's four
  tests independently passed. Neither review reran a live campaign.

Observer SHA `affeb70b36d023f6e2e2d2432dc7de4916a49c06866d986f2a291b14106de352`;
Python test SHA `64a2812507c8a598884d765a9b3221b294a17a0b755602f0325a7f3e36d4d9b3`;
assembler SHA `d92f291434b0d82fa6dd5dff8e235bed322cafeb88be746200bdc3177eeb0b99`.

Fixture owner `00000000-0000-4000-8000-000000001070`, pinned image
`sha256:5478d6a069d57a5b96cfd74e18476ffe16fe5c53dad22dab674467c1de472763`,
network disabled, no mounts or privileged mode, 240-second maximum lifetime.
Container `ec7bbc0cbf936136781b3772609c7c347da6005c17b879255665ddb1e3889ad3`
was explicitly stopped. Subsequent owner-filter and exact volume checks were
empty for anonymous volume
`35fa86efd1b6d579d1784e31a08da571701f2cf4431769630e0715e5e736a17a`.
No Canary VM, retained computer, deployment, migration or provider purchase
changed. No additional model or Hetzner spend; no temporary fixture remains.

Status: PASS for source-component checks, **not live-integrated acceptance**.
Next is the fenced activation host caller and strict observation/result handling,
then native readiness and binding publication. End-user attachment, detach,
recovery, Windows/Omarchy launch gates and the full core-experience goal remain
open. Rollback is to leave these uncalled components unused; no live rollback
or operation release was performed.
