# Regression Lockdown

This repo already has meaningful dashboard tests. The gap this document closes is durability: when high-risk code changes, the pull request must leave behind proof that the change is protected.

The verification model is risk-based, not ceremonial. Tiny local changes should get the smallest relevant check. Normal changes should get the relevant tests plus a basic sanity check. Risky or user-facing hot paths should get focused hot-path or smoke-contract tests, broader verification when practical, and a canary check after the GitHub/Vercel build.

For dashboard work, use this helper to pick the expected level:

```bash
cd dashboard
npm run verify:plan -- --risk tiny
npm run verify:plan -- --risk normal
npm run verify:plan -- --risk high
```

The hot-surface guard still enforces regression-test coverage for protected paths. The risk-based rule changes how much verification we expect, not the requirement to protect real fixes against regressions.

## Phase 1 guardrails

These are the guardrails now in place for the dashboard:

1. `dashboard-ci.yml` enforces append-only Supabase migrations.
2. `dashboard-ci.yml` enforces hot-surface regression coverage for protected dashboard paths.
3. `dashboard-ci.yml` runs a named hot-path regression suite before the full dashboard verify pipeline.
4. Pull requests now carry an explicit regression-proof section.
5. High-risk paths and workflow files now have `CODEOWNERS` coverage.

## Phase 2 hardening

These are the extra protections added after the initial lockdown:

1. The stale in-repo Hermes image workflows were removed because the live agent image now ships from the separate `vanilla-hermes-agent` fork, not from this repo.
2. A repo-scoped `.githooks/pre-push` gate now runs the dashboard regression lock before pushes from this clone.
3. The current clone is configured to use `.githooks` as its `core.hooksPath`.

## Phase 3 bootstrap hardening

These are the extra protections added to reduce the “other clone / other machine” gap:

1. `dashboard/scripts/install-git-hooks.cjs` now auto-installs the repo-scoped hooks path when run inside a clone of this repo.
2. `dashboard/package.json` now runs that installer from `postinstall`.
3. A regression test now covers the installer behavior in both the configured and non-git cases.

## Phase 4 contract hardening

These are the extra protections added to cover the dashboard-to-runtime boundary instead of only in-dashboard paths:

1. The hot-surface guard now also watches the dashboard↔agent web API bridge, official dashboard handoff, interactive terminal bridge, sidecar management contract, upstream compatibility audit code, and the root `docker-compose.yml` runtime topology file.
2. The named hot-path suite now includes existing contract tests for `agent-web-api`, official dashboard handoff, sidecar script generation, Hermes upstream audit, interactive terminal routing, official dashboard routing, and integrations routing.
3. A lightweight root runtime-topology regression test now checks the checked-in `docker-compose.yml` wiring so sidecar/agent deployment drift is no longer invisible to the dashboard test pipeline.

## Phase 5 hosted and upstream hardening

These are the extra protections added to reduce the remaining “cross-repo drift” and “hosted CI blind spot” gaps:

1. `dashboard-ci.yml` now triggers on root `docker-compose.yml` changes, so hosted verification runs even when runtime topology changes without a dashboard source edit.
2. `dashboard/scripts/check-hermes-upstream-audit.cjs` now compares the committed `dashboard/hermes_upstream_audit.md` against a freshly generated audit from live upstream/fork state.
3. `.github/workflows/upstream-compatibility.yml` now runs that upstream audit check on a weekly schedule and on manual dispatch.
4. `dashboard/package.json` now exposes `npm run audit:upstream` and `npm run audit:upstream:check` for local use.

## Phase 6 deployment contract smoke layer

These are the extra protections added to make the highest-risk deployment contracts fail earlier in CI:

1. `dashboard/package.json` now exposes `npm run test:smoke-contracts` as a focused suite for runtime topology, gateway routing, Hetzner instance wiring, instance action routes, dashboard health and browser-session routes, dashboard↔agent bridge code, official dashboard handoff, sidecar script generation, and the deployed instance contract routes.
2. `dashboard-ci.yml` originally ran that smoke suite immediately after dependency install, before the broader hot-path suite and the full verify pipeline.
3. This created a fast, explicit failure point for the cross-boundary surfaces that have been regressing even when the wider dashboard test suite is still green.
4. Since 2026-09-25 `dashboard-ci.yml` runs the full jest suite as four duration-balanced parallel shards (about five minutes end to end), which already include every smoke-contract and hot-path suite, so the separate serial steps were removed. Both scripts remain for focused local runs.

## Phase 7 live instance smoke hardening

These are the extra protections added to close the remaining “tests are green but the running stack drifted” gap:

1. `dashboard/scripts/live-instance-smoke.cjs` now probes a real running instance in two modes:
   - recommended `dashboard` mode via the existing Clerk-protected dashboard routes `/api/instances/[id]/health` and `/api/instances/[id]/browser-sessions`
   - fallback `direct` mode via the gateway `/v1/models` and sidecar `/_camofox/health` endpoints when dashboard session auth is not available
2. `.github/workflows/live-instance-smoke.yml` now supports both manual dispatch and weekly scheduled smoke runs, using GitHub variables for target selection and secrets for auth material.
3. `test:smoke-contracts` now also includes the gateway helper tests and the instance health / browser-session / instance-action route tests so the fast CI layer catches more runtime-boundary regressions before full verify.

## Phase 8 every test is run, and the merged result is verified

Added 2026-09-25, after an audit found 21 test files in `dashboard/scripts` that nothing ran, one of them failing since it was published:

1. `dashboard/scripts/check-test-wiring.cjs` runs in "Current tree safety" (`public-release-safety.yml`), which has no path filter and runs on every pull request and every push to `canary` and `main`, and again in the Dashboard CI static checks. It covers the whole repository, so it cannot live only in path-filtered Dashboard CI: a pull request that touches only `scripts/`, `services/`, `docs/`, `apps/` or `contracts/` would skip it. `dashboard/__tests__/check-test-wiring.test.ts` fails if no unfiltered workflow runs it. Every test file in the repository must be discovered by jest, started by a jest wrapper, named by a workflow that runs on push, pull request or merge queue, or run by a package script such a workflow calls. Anything else needs an entry in `dashboard/scripts/test-wiring-exemptions.json` with a category (`vm`, `live`, `helper`, `needs-artifact`, or `not-in-ci` for suites whose runner has no CI job yet) and a reason. An exemption for a file that is now run, or gone, fails the check.
2. New script tests follow the existing jest-wrapper pattern: run the script as a child process and assert its own `PASS` line (`node:test` files: the TAP `# fail 0` summary). Add the suite's hosted-runner seconds to `dashboard/scripts/jest-shard-weights.json` when it takes more than about a second.
3. `dashboard-ci.yml` also runs on every push to `canary` and on `merge_group`, and only pull-request runs cancel each other, so each merged commit gets a complete run.
4. Owner setting, not code: "Verify Dashboard" is not yet a required check on `canary` or `main`. Making it required (and optionally enabling a merge queue) is what turns these runs into a merge gate. Dashboard CI is path-filtered for pull requests, so a required check also needs a plan for PRs that touch no dashboard paths. `public-release-safety.yml` has no `merge_group` trigger, so a merge queue that requires "Current tree safety" would wait forever until one is added.

## Hosted enforcement limitation

The current GitHub repository plan for this private repo does not expose classic branch protection or rulesets through the API. That means this repo cannot currently rely on hosted required-status-check enforcement the normal way.

Until that changes, the practical safety model is:

- local pre-push verification in this clone
- automatic hook installation when `npm install` or `npm ci` is run in `dashboard`
- dashboard CI on GitHub after push
- scheduled upstream compatibility audit on GitHub
- reviewer discipline from the PR template and `CODEOWNERS`

If this repo is upgraded to a plan that supports branch protection or rulesets, `Dashboard CI` should become a required check immediately.

## Protected hot surfaces

The hot-surface coverage guard currently applies to:

- `dashboard/src/app/api/billing/`
- `dashboard/src/app/api/conversations/`
- `dashboard/src/components/chat/`
- `dashboard/src/lib/hetzner/`
- `dashboard/src/lib/services/`
- `dashboard/src/lib/gateway-probe.ts`
- `dashboard/src/lib/agent-web-api.ts`
- `dashboard/src/lib/hermes-web.ts`
- `dashboard/src/lib/official-dashboard-handoff.ts`
- `dashboard/src/app/api/instances/[id]/official-dashboard/`
- `dashboard/src/app/api/instances/[id]/terminal/interactive/`
- `dashboard/src/app/api/instances/[id]/integrations/`
- `dashboard/src/app/api/instances/[id]/skills/`
- `dashboard/src/app/api/instances/[id]/oauth/providers/`
- `dashboard/src/lib/hermes-upstream-audit.ts`
- `dashboard/scripts/hermes-upstream-audit.cjs`
- `docker-compose.yml`

If a pull request changes one of those paths, it must also change at least one automated test file under the dashboard test tree.

## Hot-path regression suite

The named suite is:

```bash
cd dashboard
npm run test:hot-paths
```

It keeps the most failure-prone paths visible in CI even though the full `npm run verify` suite still runs afterwards. Phase 4 specifically uses it to keep dashboard↔agent, dashboard↔sidecar, and runtime-topology contracts visible before the broader verify pass.

## Deployment contract smoke suite

The focused contract suite is:

```bash
cd dashboard
npm run test:smoke-contracts
```

It is intentionally smaller than `test:hot-paths`. Its job is to fail fast on the most regression-prone deployment boundaries before the broader hot-path suite and full verify pass run.

## Live running-instance smoke

The live smoke command is:

```bash
cd dashboard
npm run smoke:live-instance
```

Recommended setup for the scheduled/manual GitHub workflow:

1. Set repo variable `SMOKE_MODE=dashboard`
2. Set repo variable `SMOKE_DASHBOARD_URL` to the deployed dashboard origin
3. Set repo variable `SMOKE_INSTANCE_ID` to a dedicated smoke-test instance
4. Set secret `SMOKE_COOKIE_HEADER` to a dedicated dashboard session cookie header for a low-privilege smoke user

Fallback direct mode is available when dashboard-route auth is not practical:

1. Set repo variable `SMOKE_MODE=direct`
2. Set repo variable `SMOKE_GATEWAY_URL` to the target gateway base URL
3. Set secret `SMOKE_API_SERVER_KEY` to the gateway bearer token

Dashboard mode is the stronger signal because it exercises the actual dashboard→agent and dashboard→sidecar routes instead of probing the gateway directly.

## Local push gate

The repo-scoped pre-push hook lives at:

```bash
.githooks/pre-push
```

It runs:

1. `npm run guard:hot-surfaces -- --base <merge-base> --head HEAD`
2. `npm run verify`

This is the strongest enforcement available in the current private-repo setup because it blocks pushes from this working copy before they leave the machine.

The hook is now auto-installed for typical developer clones when they run:

```bash
cd dashboard
npm install
```

or

```bash
cd dashboard
npm ci
```

## Reviewer expectations

When reviewing a change in a protected surface:

1. Check that the regression-proof section in the PR is filled in.
2. Check that at least one relevant automated test changed with the code.
3. Check that the verification level matches the risk of the change instead of requiring full verification for every tiny edit.
4. Prefer the smallest safe change over a broad refactor.
5. Reject fixes that only add UI guardrails or fallback messaging while leaving the root cause untouched.

## What this does not solve yet

The regression lock now covers much more than Phase 1 did, but it still does not yet guarantee:

- dashboard-to-agent contract safety across repos,
- merge-blocking live smoke on every pull request,
- branch protection settings in GitHub,
- protection for every dashboard path,
- non-expiring dashboard auth for smoke workflows,
- or hook installation in clones that never run `dashboard` dependency install.

Phase 5 closes part of the cross-repo visibility gap by surfacing upstream drift on a schedule, and Phase 7 closes part of the post-deploy gap with a real running-instance smoke workflow, but neither one automatically blocks merges the way required GitHub checks would.
