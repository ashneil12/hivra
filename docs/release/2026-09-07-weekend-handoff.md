# Hivra Canary: end-of-weekend handoff

Snapshot: 2026-09-07 07:28 UTC / 08:28 Europe/London.

**Overall status: partial, not finished.** The accepted Canary UI and Ubuntu
open/reconnect path work within their recorded checks. The new attachment
backend is source-only and must not be deployed wholesale or exposed as ready.
This handoff consolidates the latest continuation checkpoints; older campaign
receipts retain their own exact scope and are not silently upgraded by this one.

## Current release and contribution state

| Surface | Verified state |
| --- | --- |
| PR #600 | Open, branch `codex/hivra-core-experience-plan`, targeting `main`; no merge performed |
| Source before this handoff | `9dc6941a895ea9d360443c733ab7274fefecc23f`; working tree clean |
| Canary web | `dpl_DP9fmpYx879wtrRyYEHf79APFSgo`, Ready; fresh custom-alias inspection confirms it |
| Canary release source | `ddf11e93b1cbb9ffec32d3bf25d198df4d5e2677` |
| Applied Canary migrations | Latest is `20260906140000`, freshly queried; later attachment migrations remain unapplied |
| Release worktree | `/tmp/hivra-launch-disclosure.1HQdB0`, HEAD `219eef6fa8ac3b2ce23648b644c8096ae23bc516`; exact zero tree diff from accepted release source |
| Real production | No deployment or publication in these continuation slices |

Canary: https://canary.hermesos.cloud

PR: https://github.com/ashneil12/hermesdeploy-canary/pull/600

Do not deploy current main-task HEAD as the Canary bundle: it intentionally
contains unapplied backend groundwork excluded from the clean UI release.

## Recent completed and rejected slices

- Launch profile previews: unavailable Omarchy/Windows choices are grouped in a
  disclosure, retaining disabled states and readiness links. Ubuntu Continue
  is visible in the checked small app window. Deployed/live checked; see
  `2026-09-07-launch-preview-disclosure.md`.
- Launch stage focus: forward/back transitions focus the new heading without
  stealing focus from name edits. Deployed and observed in actual app
  accessibility output; see `2026-09-07-launch-step-focus.md`.
- Sidebar persistence: both expanded/collapsed choices survive full app refresh;
  mobile drawer does not write the desktop preference. Deployed/live checked,
  38 sidebar/launch tests, typecheck/lint/review pass; see
  `2026-09-07-sidebar-persistence.md`.
- Sticky capacity footer: **rejected** because it obscured a focused name input
  in the actual Mac app despite green local tests. Source reverted and Canary
  rolled back; unobscured input was checked afterward. Do not retry this overlay
  as a proof loop. See `2026-09-07-capacity-footer-rejected.md`.
- Staging grant reread: source commit `532dd3421` checks fresh authority/dispatch
  state before stage, refuses a newly observed delete, and preserves observation-
  only recovery. Regression failed before repair; 55 focused tests and independent
  review pass. **Not deployed**; does not eliminate the final read-to-host race.
  See `2026-09-07-staging-grant-reread.md`.
- Current Ubuntu open/reconnect: retained aligned Ubuntu rendered its real
  public desktop twice in the Mac app. Individual secure setup readings were
  12.7s and 4.8s. No guest input, reboot, file comparison or new provisioning was
  performed in this check. Both test sessions were revoked and input released.
  See `2026-09-07-ubuntu-open-reconnect.md`.

## Preserved resources and cleanup

Fresh Canary database reads show all four retained computers running, desired
running, with null operation ID/kind:

| Computer | ID | VMID |
| --- | --- | --- |
| CANARY_ALIGNED_UBUNTU_0905 | `00000000-0000-4000-8000-000000001025` | 1120 |
| CANARY_RECOVERY_DEST_0905 | `00000000-0000-4000-8000-000000001018` | 1124 |
| CANARY_RECOVERY_SOURCE_0905 | `00000000-0000-4000-8000-000000001015` | 1123 |
| MY_UBUNTU_DESKTOP | `00000000-0000-4000-8000-000000001150` | 1115 |

The two recent sessions `00000000-0000-4000-8000-000000001148` and
`00000000-0000-4000-8000-000000001149` still have input state released and
non-null revocation/control-release timestamps. The app was left on Computers
with dark theme and expanded sidebar. Existing guest processes and user files
were intentionally not stopped or modified.

Fresh exact-ID Docker inspections found the three recorded protocol/native
fixture containers absent (`4b12541d…`, `7353f2de…`, `a8a8aeb4…`) and their
anonymous volumes absent (`32d3745e…`, `436d8fc4…`, `a77fd047…`). Full identities
and original cleanup evidence are in the protocol/native receipts. These checks
did not delete anything. Earlier VM campaigns retain their original teardown
receipts; this handoff does not claim a new fleet-wide disk audit.

No additional spend in these continuation slices. Conservative cumulative
Hetzner reservation remains **GBP 6.90 of GBP 10**, not a reconciled final invoice.
Do not spend the remaining allowance without refreshing quotes and checking
recorded ownership/costs. No other purchase or model spend was authorized here.

## Work that remains

1. Finish the shared attachment execution/terminal boundary: cancellation,
   observed process/session release, stale completion, and final dispatch fencing.
   Preserve unknown outcomes; neither timeout nor an old grant permits restaging.
2. Complete authority-aware binding publication, inventory readers and compatible
   rollback, then the worker/lifecycle integration. Validate the self-host and
   concurrent-writer migration path before enabling the staged SQL.
3. Only after those gates, expose normal owner-reviewed Attach Agent and verify
   useful authenticated runtime work, detach, reboot/recovery, preservation and
   cleanup on one disposable computer. Current private primitives are not that
   product flow. Do not add another UI button as a substitute for integration.
4. Complete Omarchy native pairing/input and Windows licensed-image, RDP,
   recovery/teardown gates. Neither is launchable based on Ubuntu evidence.
5. Revisit short-window Capacity layout without covering focusable controls.
   Existing scrolling works; the attempted sticky overlay is explicitly rejected.
6. Native-client distribution, public release and production rollout require their
   own acceptance/authority. No new signed/notarized public client is claimed.

Follow the current core plan and attachment cutover plan for the full gates.
UC-ATTACH-AGENT-01 and UC-DOMAIN-MIGRATION-01 remain open. Do not mark the overall
goal complete or weaken these gates because the weekend has ended.

The existing weekend heartbeat schedule was inspected and already expires at
09:00 Europe/London on 2026-09-07. No extension, duplicate schedule or claim of
uninterrupted execution was made. This is its final scheduled hourly run before
that cutoff; subsequent work needs a new continuation from the owner.
