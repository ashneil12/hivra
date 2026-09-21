# Sidebar preference survives refresh

PASS for the scoped Canary UI fix. Full core/attachment work remains open.

Before: the actual signed-in Hivra Mac app at 980×690 displayed an expanded
sidebar on Computers. Clicking its toolbar Refresh collapsed it. The component
initialized isExpanded to false and had no persistent preference read or write.
This was missing display-preference persistence, not a backend failure.

Change: restore the device-local sidebar choice after hydration and save only
explicit desktop toggles. Mobile drawer opening does not overwrite that choice.
Blocked/full browser storage leaves the toggle usable in memory. This stores
only a boolean for this origin, not account data or a cross-device preference.

## Release and evidence

- PR #600 source: `6ed5861fe`.
- UI-only Canary release: `ddf11e93b1cbb9ffec32d3bf25d198df4d5e2677`, based on
  `a0510a81d38eb77b0b21f3f599d08eda2a676911`.
- Only DashboardSidebar.tsx and its test changed from the live baseline.
- Project `prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA` / `hermesos-canary`.
- Deployment `dpl_DP9fmpYx879wtrRyYEHf79APFSgo`, Ready and promoted;
  `https://hermesos-canary-7lrh77q7b-ashneil12s-projects.vercel.app`.
- Fresh inspection of `https://canary.hermesos.cloud` resolved to that deployment.
- No real-production project deployment, backend/provisioner changes or database
  migrations. Unapplied attachment work stayed excluded; manifest remains 292.
- Regression failed before implementation: expanded choice was lost on remount.
  Final sidebar and launch suites: 38 passing tests, including both saved choices,
  mobile independence and storage failure. TypeScript, touched-file ESLint and
  whitespace checks passed. Independent source review found no blocker.

After deploying on 2026-09-07 around 04:27 UTC, refreshed the actual Mac app onto
the promoted alias, expanded the sidebar and performed a full toolbar refresh.
The accessibility tree and screenshot confirmed it remained expanded. Collapsed
it and refreshed again: it remained collapsed. Restored expanded at the end.
The same four retained computers still displayed Running and the dark theme
remained unchanged. No computer/session/volume was created or modified; no launch
was submitted. No new spend; conservative cumulative Hetzner reservation remains
GBP 6.90/10. No local server was started.

Mobile and blocked-storage behavior are unit-tested, not physical-device tested.
No account-to-account or cross-device synchronization is claimed. The initial
hydration-safe render remains collapsed before the stored choice is restored.
Rollback is prior deployment `dpl_3ssPcV9AyRQyZKLxnCXjFS9W7HeD`, not exercised.
