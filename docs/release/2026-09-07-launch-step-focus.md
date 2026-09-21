# Launch journey: step focus

PASS for this scoped UI change and Canary acceptance; full core work remains open.

The launch journey now focuses its new h1 when the draft stage changes, including
initial entry. The heading is programmatically focusable with tabindex -1, not
an extra Tab stop. Name edits and capacity refreshes do not retrigger the effect.
The missing focus was reproduced by the regression before implementation; the
pre-release app was inspected, but no native focused-element baseline was captured.

## Exact release

- Main task / PR #600 source commit: `51aa62804`.
- UI-only release commit: `a0510a81d38eb77b0b21f3f599d08eda2a676911`, on
  `8e500089c1b8825232bc8300a13ad93aa262bbc8` in the existing clean release worktree.
- Only LaunchJourney.tsx and its launch-page regression test changed.
- Canary project: `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA` / `hermesos-canary`.
- Deployment: `dpl_3ssPcV9AyRQyZKLxnCXjFS9W7HeD`, Ready and promoted;
  `https://hermesos-canary-r8njfih0b-ashneil12s-projects.vercel.app`.
- Fresh inspection of `https://canary.hermesos.cloud` resolved to that deployment.
- No production-project deployment, provisioner update or database migration.
  Unapplied attachment backend work was excluded; build manifest remains 292.

## Checks and actual interaction

On 2026-09-07 around 03:28–03:34 UTC:

- All 18 launch-page tests passed, including name-focus preservation and stage
  transitions. TypeScript, touched-file ESLint and git diff --check passed.
  Risk-plan recommendation: normal. Independent source reviewer found no blocker.
- Canary Vercel build passed. In the actual signed-in Hivra Mac app at 980×690,
  refreshed the promoted alias and restored the original expanded sidebar.
- Selected Ubuntu and continued to Capacity. Entered FOCUS_CHECK followed by
  _EDIT without refocusing: native accessibility output showed the Computer name
  field focused with FOCUS_CHECK_EDIT, confirming editing did not lose focus.
- Back preserved Ubuntu selection and native accessibility explicitly reported
  the focused element as the Choose an operating system heading. Continue then
  reported Where should Ubuntu Desktop run? as the focused heading. Both headings
  were visibly at the top of their step with a focus outline.
- Returned to Computers: the same four retained computers displayed Running.
  Used normal fresh computer launch to reset the disposable idle test draft;
  Ubuntu was unselected, Continue disabled and the profile heading focused.
  Returned to Computers, keeping dark theme and expanded sidebar.

An auxiliary read-only System Events focus query was unavailable; subsequent
native app accessibility snapshots supplied the focused-element evidence above.
No VoiceOver speech, exhaustive keyboard traversal, new VM launch, or new native
binary is claimed by this check. No Launch submission, session, VM or volume was
created. A fresh idle computer draft remains, not a pending operation. No extra
spend; conservative cumulative Hetzner reservation remains GBP 6.90/10.

Rollback is prior Canary deployment `dpl_E66T8Js4vyLheVy7zHUhRKzTNXpD`; not
exercised because checks passed. The release worktree remains for exact-source
reproducibility; no local server was started.
