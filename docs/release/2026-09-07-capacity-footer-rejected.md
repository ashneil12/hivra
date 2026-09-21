# Capacity sticky footer: rejected and rolled back

FAIL for the attempted sticky-footer change. Rollback is complete; the previously
accepted sidebar-persistence release remains live. Do not treat this attempt as
a shipped capacity-layout improvement.

At 980×690 with an expanded sidebar, the original Capacity form places Continue
below the visible area. A capacity-only, desktop-only sticky footer was attempted
to keep Back/Continue reachable, leaving final review/Launch in normal flow.
The attempt followed the onboarding goal of a clear next action, but its actual
focus behavior failed acceptance.

- Attempted main commit `bfb0677e0`; UI-only release
  `a46b7adfae579519dab4c1160ced09d1436a0c6c`.
- Temporary Canary deployment `dpl_C5UWWUzb4VsJBuj8qZ6BXquoCyZm` /
  `https://hermesos-canary-854b2jcny-ashneil12s-projects.vercel.app`.
- Regression correctly failed before implementation; final attempted source
  passed 39 sidebar/launch tests, typecheck, lint and independent source review.
  None of those checks established unobscured focused-input rendering.
- Actual Mac-app check on the promoted alias showed Continue immediately, but
  clicking and typing in Computer name left the focused field behind the footer.
  Native accessibility reported CAPACITY_NAV_CHECK in the focused field while
  its text was visually obscured. This is an accessibility/usability regression.

At approximately 04:35 UTC on 2026-09-07, promoted the known-good deployment
`dpl_DP9fmpYx879wtrRyYEHf79APFSgo` back to Canary. Fresh alias inspection confirmed
`https://hermesos-canary-7lrh77q7b-ashneil12s-projects.vercel.app` / Ready.
Main revert `8f40acb1d` is pushed. Release-worktree revert
`219eef6fa8ac3b2ce23648b644c8096ae23bc516` has an exact zero tree diff from accepted
release source `ddf11e93b1cbb9ffec32d3bf25d198df4d5e2677`.

Refreshed the Mac app, which reset the disposable idle draft through the existing
fresh-launch URL. Selected Ubuntu and returned to Capacity: no floating footer;
the original name was visible, and clicking it showed its selection and focus
outline unobscured. Returned to Computers with the expanded sidebar and dark
theme retained. No Launch submission, VM, process, session or volume was created.
No database/provisioner/real-production change or new spend occurred. Conservative
Hetzner reservation remains GBP 6.90/10.

Do not retry this overlay approach without a separate layout design that reserves
real viewport space and proves focused-control visibility. Next layout work should
reduce excessive intro spacing or use a non-overlapping layout. Original capacity
scrolling remains usable but the short-window next-action improvement stays open.
