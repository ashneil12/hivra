# Provider resize feedback during installation

Status: source regression fixed, independently reviewed and deployed to Canary.
General desktop/Manage smoke passed; the provider-installation warning has not
yet been re-exercised live. No purchase or provider mutation in this change.

## Reproduction and cause

The normal Manage screen on the active provider Ubuntu cancellation fixture
showed “The original resize is saved but its result is not verified,” although
the actual operation was provision and no resize had been requested. The live
target/revision and test cleanup are recorded in
`2026-09-06-provider-interrupted-install.md`.

`loadProviderResizeAuthority` required successful, stopped installer evidence
before `liveSnapshot` could classify provisioning as busy. An active installation
has NULL outcome/stopped timestamp, so validation became store `unavailable`,
then `operation_unverified`, and the route supplied the inaccurate saved-resize
message. This is a code defect, not a change to the intended resize contract.

## Change and checks

A separate strict classification schema recognizes only an owner/ID-matched
provider computer in provisioning with an original provision operation and
NULL installer outcome/stopped timestamp. It throws `computer_busy`; it never
returns resize authority. The existing route displays its operation-in-progress
message. Completed-install validation, provider identity, billing confirmation,
disk policy, saved-resize observation and mutation fences are unchanged.

The two new initial regressions failed on the prior source with `unavailable`
and `operation_unverified`, respectively. Focused store/service/route suites
pass, including malformed/foreign evidence refusal, existing saved operations,
and no credential/pricing/mutation calls on the new busy path. TypeScript
`tsc --noEmit --pretty false` passed. Independent reviewer reran the store/service
suites (60 tests) and found no P1/P2 issue in the implementation boundary.

No current provider fixture exists to repeat the live screen without a new
purchase. Do not purchase solely to prove this feedback change. Verify it during
the next justified provisioning campaign after the source reaches Canary.
Unknown/failed installer states remain fail-closed and are not claimed fixed by
this bounded classification. Full computer-platform acceptance remains open.

Rollback: revert this source commit through the existing branch/PR flow; no
schema migration, resource cleanup or live rollback is required at this stage.

## Canary deployment and bounded smoke, September 6

Clean committed source `dc03efa3dc214207d6e67f2a5d07f20ee77d6dbb` was exported
to `/tmp/hivra-resize-feedback-deploy.L8mmAj`. The exact verified Vercel
project was `hermesos-canary` / `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, root dashboard,
Node 24. The actual production project was excluded. The expanded focused
store/service/route/Manage suites passed **94 tests**. Vercel build, TypeScript
and static generation passed; deployment
`dpl_H85X5fu1ZBHhTdtRGGy9nVNso7DM` reached Ready and fresh alias inspection
confirmed `https://canary.hermesos.cloud` points to
`https://hermesos-canary-mw4ceuu2f-ashneil12s-projects.vercel.app`.

Through the existing authenticated Mac Alpha UI, opened
`CANARY_ALIGNED_UBUNTU_0905` (`00000000-0000-4000-8000-000000001025`, VM1120)
and pressed the native refresh button once after deployment. The page
reconnected automatically with a new session; its browser setup measurement was
5.1 seconds. The rendered KDE desktop, wallpaper and taskbar were visually
inspected. No second refresh was used. Manage then rendered the expected
running state and 2 CPU / 4 GB controls. No power, resize, update, restore-point
or file mutation was submitted. This is a managed Ubuntu smoke, not provider
warning acceptance, a physical monitor-unplug check or a latency benchmark.

The previous session `00000000-0000-4000-8000-000000001142` was revoked and its
controller released at 04:47:55.44791 UTC. Manage retains the desktop session
while changing tabs; returned to the Computers inventory to close the new
session `00000000-0000-4000-8000-000000001143`. Final SQL readback confirmed
revocation at 04:48:57.863522 UTC and input released at 04:48:58.880499 UTC.
The inventory again showed all four original Ubuntu computers Running, each
2 CPU / 4 GB. No paid fixture was created. Budget reservations stay
£6.90/£10. The preceding Ready deployment
`dpl_2G7xzCL2Xc8PqhWTfSmFTaFmo7nm` is the Canary rollback target if needed;
rollback was not exercised.
