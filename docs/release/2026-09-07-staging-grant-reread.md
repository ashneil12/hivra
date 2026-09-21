# Attachment staging: reread after dispatch grant

PASS for the scoped source regression fix. Not deployed or live-accepted as an
attachment workflow. Full UC-ATTACH-AGENT-01 and UC-DOMAIN-MIGRATION-01 stay open.

## Defect and repair

The staging coordinator used its earlier claimed snapshot immediately after a
literal-true dispatch grant. The host adapter receives that supplied source row;
resolving its infrastructure context is not a fresh read of attachment desired
state. Unlike the activation coordinator, staging had no intervening execution
snapshot check. A deletion visible immediately after the grant was therefore
ignored by that coordinator path.

Commit `532dd3421` rereads the owner-bound, strictly parsed execution snapshot
after the grant. It requires exact equality with the expected claimed-to-
dispatched transition and this pass's dispatch ID. A pending delete, changed
authority/guest/installation/boot, unexpected recorded result, missing read or
read failure leaves the grant held without calling stage. The fresh snapshot is
used for the host row and result persistence. This does not revoke the grant,
release the lifecycle slot or authorize another attempt; subsequent dispatched
passes retain their observation-only path.

## Evidence

On 2026-09-07, the new pending-delete regression failed before the repair: the
old coordinator returned staging_recorded instead of held. After the repair,
55 tests across staging coordinator, activation coordinator and host executor
passed in 2.774 seconds. Their staging snapshots come from the actual isolated
PostgreSQL fixture; host execution and the interleaved reads are mocked.
Checks cover both successful call ordering and blocked changed snapshots, plus
a failed post-grant read followed by observation-only recovery. TypeScript,
touched-file ESLint, whitespace checks and independent source review passed.

No new SQL migration, application grant, worker registration, host/guest action,
Canary deployment, or live computer mutation was performed. The fix is pushed
to the existing PR #600 branch, not merged. No resource cleanup was needed and
no spend was incurred; conservative Hetzner reservation remains GBP 6.90/10.
The Canary release worktree was not changed by this backend-only slice.

## Remaining boundary

This closes the missing coordinator reread, not the final read-to-host race.
An operation can still change after the new read, and an earlier artifact fetch
may already have occurred before the grant. Shared guest execution fencing,
terminal/cancellation reconciliation, observed process/session release and
worker/lifecycle cutover remain required before exposing attachment. Sequential
mock interleavings do not establish concurrent live acceptance. Do not enable
the staged migrations or call the coordinator from an HTTP route on this evidence.

Rollback of this source-only patch is an explicit revert of `532dd3421`; no live
rollback was necessary. No retained computer or user data was touched.
