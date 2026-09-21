# Activation host transport and result validation — 2026-09-06

Source-only continuation from `4efb48881`, PR #600. The internal adapter is not
called by a route or worker and adds no dispatch privilege. The future durable
orchestrator must hold the original operation/generation fence and receive a
fresh successful one-time DB dispatch result before start. A historical record
or a successful observation cannot grant another start.

The adapter snapshots the owner-bound SQL execution and activation records
before resolving infrastructure, verifies the resolved enforced binding tag,
then packages the reviewed guest action. On the resolved host, the existing
shared allocation lock covers VM running/tag/IP checks and exact VMID QGA
execution. There is no private-IP SSH fallback or caller-supplied command.
Fixed start/observe limits are 210/90 guest seconds and 290/170 host seconds,
with a 32 KiB output cap. These are durable-worker operations, not short HTTP
handlers. Ambiguous or invalid responses return typed uncertainty without retry
or disclosure of raw infrastructure errors.

Strict output parsers bind service-start receipts and observations to the
original activation, operation, installation, boot and generated unit hash.
They reject unknown fields, malformed IDs/PIDs, unsafe numeric inode values,
contradictory phases and invented readiness. Pending-delete starts are rejected
before context resolution; pending-delete observations remain available.
An inactive result is not descendant/socket/session release evidence.

## Verification and limits

- Two focused suites: **11 tests passed in 3.293s**. Actual SQL fixture records
  feed script construction and result parsers. Each generated shell passed
  `bash -n`; host execution and guest results were mocked.
- Tests cover one bounded call per action, owner/deletion gates, binding/context
  errors, mutation of caller inputs while awaiting context, malformed/stale
  results and uncertain transport without retries.
- Full TypeScript and touched-file lint checks passed. An initial test-only
  unused-variable lint warning was removed; final lint and diff checks are clean.
- Independent bounded review found no P1/P2 and independently passed all seven
  host/result tests. No live QGA campaign was rerun.

Host adapter SHA `b27ba244b9f1590e866e5617eaf7d289978a9f941c0a430f8eabd38580fc44af`;
result parser SHA `25a0c18ee2377de92fdacce6f8a21a057b6cff245b05380ecbdb3796977d7274`.

Status: PASS for source-component checks, not live-integrated acceptance.
No VM, retained computer, database migration, deployment or capacity changed;
no temporary resources or additional spend. Rollback is to keep the unregistered
adapter unused. The one-pass activation orchestrator, observed-result persistence,
native readiness, binding publication and end-user attachment remain next. The
full core-experience goal stays open.
