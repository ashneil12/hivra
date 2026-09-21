# Computer-profile onboarding: visible next action

PASS for the scoped UI change and deployed Canary acceptance.

Before: at the actual Hivra Mac app window size (980×690), with the sidebar
expanded, selecting Ubuntu left Continue below the viewport because two
unavailable OS cards preceded it. This was observed in the signed-in normal
Canary journey, not inferred from a unit test.

Change: place the existing Omarchy and Windows preview cards in a closed native
details disclosure labelled “Omarchy and Windows · not launchable yet”. Existing
disabled states, readiness explanations/links, Ubuntu selection and Continue
gating are preserved. A keyboard-focus style accompanies the native summary.
The onboarding skill informed separating the actionable choice from secondary
preview information; no marketing redesign or new design system was introduced.

Source:

- Main task/PR #600 commit `e2d5dae6a`.
- Exact Canary deployment commit `8e500089c1b8825232bc8300a13ad93aa262bbc8`,
  a UI-only cherry-pick on the previously deployed
  `5a557ae8efd514df8cd834601d1e1aae5c79f02a`.
- Only LaunchJourney.tsx, its CSS module and the launch-page test differ from
  that live baseline. Unapplied attachment migrations/backend work were excluded.
- Clean release worktree retained at `/tmp/hivra-launch-disclosure.1HQdB0`
  on `codex/canary-launch-disclosure`; no development server is running there.

Deployment:

- Exact project `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA` / `hermesos-canary`.
- Deployment `dpl_E66T8Js4vyLheVy7zHUhRKzTNXpD`, Ready and promoted.
- URL `https://hermesos-canary-afy1z8dyr-ashneil12s-projects.vercel.app`.
- Fresh inspection of `https://canary.hermesos.cloud` resolved to this deployment.
- The Vercel `production` slot is this Canary project's slot, not the separate
  production project. No production deployment or database migration occurred.
- Rollback is prior Canary deployment `dpl_HAxsTsp6Ks13iigMkhfEYtRvytHU`; it was
  not exercised because the scoped checks passed.

Verification:

- New regression failed before the disclosure existed. The final launch suite
  passes all 17 tests, including unavailable-state preservation and existing
  submission/recovery/capacity behaviour. TypeScript, touched-file lint and
  whitespace checks pass; the risk-plan tool recommends normal verification.
- Independent source review found no blocker and separately passed 17 tests.
- Vercel build passed, retaining the live baseline's 292-migration manifest.
- In the actual signed-in Hivra Mac app on the promoted alias, restored the
  original expanded sidebar, selected Ubuntu and visibly verified Continue
  without scrolling. Clicked Continue into Capacity, then Back; Ubuntu remained
  selected. Expanded the disclosure: both OS buttons stayed disabled. Followed
  the Windows readiness link into the existing Windows section and returned to
  Computers. The same four retained computers still displayed Running.

No Launch submission was sent and no VM, process, volume or desktop session was
created. The UI-only check leaves an idle Ubuntu draft, not a pending operation;
the app is back on Computers with its original dark theme and expanded sidebar.
No secrets, existing files or machines were modified. No additional capacity
spend; conservative cumulative Hetzner reservation remains GBP 6.90/10.

This confirms the profile-step improvement at the observed app size. It does not
claim a fresh launch, exhaustive mobile/screen-reader testing, Windows/Omarchy
availability, a new native-app binary, or completion of the full attachment flow.
