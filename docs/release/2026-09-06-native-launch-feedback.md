# Native-sign-in launch feedback — 2026-09-06

Source `3eaf0a7da`, branch `codex/hivra-core-experience-plan`, PR #600.
Normal-risk presentation-only change; no provisioning, auth, billing, retry,
request payload or saved-launch state changes.

## Observed gap and repair

The preceding `CANARY_BROWSER_KEYS_0906` live launch showed only the disabled
`LAUNCHING CLAUDE CODE...` button while waiting for confirmation. The page later
advanced automatically, but nothing distinguished the pending request from
installation. The dashboard-agent form already supplied that distinction.

Claude Code and native-sign-in Codex now show a polite, atomic status above the
button, explaining the pending confirmation and automatic setup navigation.
The button references that status for assistive technology. Both disappear
from the pending state when the request settles. The separate saved Codex
model-connection flow is excluded because it has its own confirmation controls
and must not promise automatic navigation.

Onboarding guidance informed the concise next-step explanation; no invented
percentage, queue position, allocation or install-stage claim is added.

## Source checks

- Both new native-runtime regressions failed before the change because the
  status was missing.
- Final WelcomeFlow suite: 84 passed, six existing skips. New cases check
  accessible pending feedback, single submission and rejection cleanup for
  Claude Code and native Codex. Existing accepted-launch and saved-request
  tests remain in the full suite.
- Full dashboard TypeScript passed. Scoped ESLint had zero errors and two
  existing warnings (unused Link, selectedPersonaId dependency).
- Diff whitespace passed. Clean deployment export's WelcomeFlow SHA matches
  source: `5d059c47d4ea86676a252f7687778048fa3fe9444b481be896ad3881ca4e6219`.

## Canary rollout

Deployment and post-release form sanity: PASS. Exact project was checked as `hermesos-canary`,
`prj_XEG52ZLtihRGP8Fg6pDZwQCATzVA`, root `dashboard`, Node 24.
Clean Git export contains the exact source commit, not local uncommitted work.
Actual production, guest bundles, running computers and database were not
changed. The preceding sidecar dependency repair is not published by a dashboard
deployment. Rollback target is prior Canary `dpl_n5XLDxTL3iPQUBgFrTZR8VXLPTeh`.

No provider spend or new runtime fixture is required for this presentation-only
rollout. Pending-state behavior has component evidence; a fresh live submission
solely to watch this message is deliberately not repeated. Record post-release
form sanity separately from dynamic-message live acceptance.

Deployment `dpl_C3kYB9fN4oRKBKffL2PJVo8VqK5C` built successfully and reached
Ready. Fresh inspection of `https://canary.hermesos.cloud` resolved to that
deployment, `hermesos-canary-21dii4jg2-ashneil12s-projects.vercel.app`.
Build warnings included existing pending install-script approvals, deprecated
Edge Runtime use and skipped PostHog sourcemap upload with missing configuration;
none was silently represented as a passing check for those separate concerns.

By 08:02 UTC, the logged-in root-path Mac app was refreshed onto Canary. Home
showed the retained four computers and two agents, all Running. Normal Agents →
Deploy Agent → Claude Code opened the complete launch form, loaded managed
capacity, retained 2 CPU / 4 GB and browser support, and enabled Launch.
No pending status appeared while idle. Returned Home without submitting,
changing provider settings, opening a desktop session or creating capacity.
This is actual deployed form sanity, not post-release dynamic-message acceptance.

The exact owned clean-export directory was removed after deployment completed,
and absence verified. No rollback was required or exercised. No additional
spend; conservative cumulative Hetzner reservations remain GBP 6.90 / 10.
