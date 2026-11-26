# Dashboard E2E — Tier 1 of the QA pyramid

**Tests never create accounts**, in CI or by hand. Don't create Clerk users or
invitations, and don't submit a sign-up form. Authenticated checks sign in as
standing Canary test accounts from environment variables; logged-out checks
must stop at the auth boundary. Don't log or commit account addresses, session
state, or browser artifacts from sign-in. The operator-run repair command below
is the only exception, and only when its configured standing account is missing.

**Live managed-hosting audits are blocked by default.** Run them only on an
owner-approved isolated runner with `HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp` and
the relevant project flag. Sign-in uses Clerk's fixed test OTP, not tickets.
Tear down only the resources owned by the run, never the account.

### Venice claim acceptance — no provisioning or credit grants

```bash
cd dashboard
CANARY_QA_EMAIL=… npm run test:venice-claim
```

The spec signs in as the standing account, opens `/venice`, and follows the
rendered claim link to the exact authenticated Launch URL. JavaScript is
disabled for this check, so the Launch client cannot run its credit-grant or
provisioning requests. This checks the document handoff, not the hydrated
review UI or credit redemption.

## Weekly general check

Run this representative offline check weekly on a clean checkout of the
current `canary` head, with lockfile dependencies already installed and no
service credentials or local environment files. On Linux, use a network
namespace without external network access. If the runner cannot isolate the
check, report it as blocked rather than falling back to a live suite.

From the repository root:

```bash
unshare -Urn -- env -i PATH="$PATH" CI=1 bash -e <<'SH'
node dashboard/scripts/check-test-wiring.cjs
node scripts/release/public-tree-hygiene.mjs
cd dashboard
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  __tests__/managed-hosting-audit-pause.test.ts \
  __tests__/first-run-audit-hivra-cleanup.test.ts \
  __tests__/trial-to-pro-state.test.ts \
  __tests__/launch-sweep-result.test.ts \
  src/lib/billing/__tests__/card-trial.test.ts \
  src/app/api/workspace/sessions/__tests__/owner-routes.test.ts \
  src/lib/launch/__tests__/launch-catalog.test.ts \
  src/lib/hivra/__tests__/provider-agent-launch.test.ts \
  src/lib/hivra/__tests__/managed-session-transcript.test.ts \
  'src/app/api/hivra/agents/[id]/action/__tests__/sleep-aware.test.ts' \
  src/lib/hivra/__tests__/agent-delete-cleanup.test.ts
SH
```

Record the tested SHA, offline pass/fail and affected surfaces. This samples
auth, trial and billing state, tenant ownership, catalog and launch contracts,
chat transcript handling, wake and cleanup. No Playwright suite, real sign-in,
payments, model calls, provisioning or customer data is involved. A read-only
lookup of the public Canary deployment revision is separate from these tests.

This does not change protected CI or the [managed release process](../../docs/release/MANAGED-HOSTING-RELEASES.md).
It must not publish a `launch-sweep` status or replace a required sweep.
The proposed [Promote gate](https://github.com/ashneil12/hivra/pull/593) stays
held until an isolated runner using an approved auth path records a passing
sweep on the exact served Canary revision. Live auth and release sweeps still require
the explicit opt-in above; changed-agent installers need isolated execution and bounded, revocable
test model access before they can be enabled.

## Playwright (not part of the weekly check)

Playwright targets a deployed site and is separate from the offline baseline.
Do not assume every public spec is read-only: the telemetry spec checks real
ingestion. Live managed-hosting projects still need their explicit opt-in.

## Layout
- `public.public.spec.ts` — logged-out routes render (HTTP < 400 + real content) + VRT.
- `venice.public.spec.ts` — the unsigned Venice acquisition contract: promo claim target, attribution cookie and auth-boundary Launch deep-link preservation. It deliberately stops before account creation.
- `venice-claim.acceptance.spec.ts` — opt-in standing-account check for the signed-in claim link and Launch document.
- `golden-deploy.authed.spec.ts` — the signed-in **dashboard → Launch chooser** golden path.
- `onboarding-deploy.journey.spec.ts` — the signed-in **Launch chooser → Codex review** journey. It checks launch readiness without clicking Launch Codex.
- `first-run-audit.spec.ts` + `first-run-audit/` — the **19/20 gate**. Real provisioning. See below.
- `global-setup.ts` — signs in as the standing Canary QA account when `CANARY_QA_EMAIL` is set; otherwise rejects legacy ticket sign-in and writes empty storage state.
- `playwright.config.ts` (repo root of `dashboard/`) — projects: `public` (no auth), `authed` (storage state),
  `offline-browser` (local routed fixtures), and the explicitly gated live audit projects.

## Run it
```bash
npm run test:e2e            # all, against E2E_BASE_URL (default https://canary.hermesos.cloud)
npm run test:e2e:public     # public smoke + VRT only (no secrets needed)
E2E_BASE_URL=https://<vercel-preview>.vercel.app npm run test:e2e   # gate a PR preview
```

## Env (authed path only)

Authed specs sign in as the standing Canary QA account when `CANARY_QA_EMAIL`
is set (see below); without it setup writes empty storage state and they skip.
The old `QA_USER_ID` ticket-auth path stays disabled: if both
`CLERK_SECRET_KEY` and `QA_USER_ID` are present and `CANARY_QA_EMAIL` is not,
setup fails closed rather than minting a Clerk sign-in ticket. Do not re-enable
sign-in tickets.

## Standing Canary QA account

One passwordless `+clerk_test` account on the Canary Clerk development
instance, with the Pro plan and a small Hivra credit balance, is shared by every
person and agent that needs a signed-in Canary session. Use it instead of
inventing a new login flow. Its address is the only thing that guards it (the
code is public and Clerk's test code is fixed), so it is never written in this
repository, a PR or a comment. Ask the owner for it; it is kept in private
notes.

**Sign in by hand:** open `https://canary.hermesos.cloud/sign-in`, enter the
address, press Continue and type `424242`. No mail is sent.

**Sign in from Playwright:** set `CANARY_QA_EMAIL` and run any authed project.
`global-setup.ts` signs in through the real sign-in page and writes
`e2e/.auth/qa-user.json`, which the `authed`, `vrt` and `journey` projects
already load. A spec that needs its own context can call
`signInAsCanaryQa(page, { baseUrl })` or `saveCanaryQaStorageState` from
`e2e/canary-qa/auth.ts`. Neither needs a Clerk secret.

```bash
CANARY_QA_EMAIL=… npx playwright test --project=authed
```

**Repair it:** `npm run qa:canary-account` creates the Clerk user if it is
missing and resets its Canary rows: Pro plan and pool, a low-risk sign-up
assessment, and Hivra credit set back to $2 (`CANARY_QA_CREDIT_USD`, at most
$5). It is idempotent. It needs `CANARY_QA_EMAIL`, the Canary
`CLERK_SECRET_KEY` (`sk_test_…`), and the Canary Supabase URL and
service-role key (`CANARY_QA_SUPABASE_URL`, `CANARY_QA_SUPABASE_SERVICE_ROLE_KEY`).
It refuses `sk_live_` keys, any Supabase project but Canary, and any address
that is not a `+clerk_test` address on a reserved example domain. It prints the
user id, plan and credit, never the address or a key.

**Limits:** the account holds the Pro plan only, so it can run at most three
agents within 2 vCPU and 4 GB in total, and model use stops when its credit runs
out. Delete agents you launch with it when you are done, and run the repair
script to put the credit back.

## VRT baselines
Screenshots are OS-sensitive — **generate baselines on the Linux CI runner**, never commit
macOS-generated ones. First-time / refresh:
```
gh workflow run dashboard-e2e.yml -f update_snapshots=true   # uploads baselines as an artifact
```
Commit the artifact's `*-snapshots/` into `dashboard/e2e/` once, then VRT gates real diffs.

The golden and onboarding deploy specs stop before provisioning. The real launch
is exercised by the opt-in `first-run-audit` spec below.

---

# FIRST-RUN AUDIT — the 19/20 gate

This audit measures launch through first real outcome, with a 19/20 pass
target. It starts signed in with the standing account's existing plan; it
doesn't measure account creation or a new user's first entitlement.

It provisions one Canary computer per run and cannot fire on an ordinary CI push:

1. `playwright.config.ts` only *defines* the `first-run-audit` project when `FIRST_RUN_AUDIT=1`.
2. The spec itself `test.skip`s unless the same var is set.

## What "first real outcome" means here

The default audit deploys a clean-slate box without configuring inference. It
checks that the agent exists, boots, and opens an interactive workspace
(`workspace_interactive`):

```
instance row → running, observed via GET /api/instances/[id]
  AND the box's gateway answers the app's own /health probe
  AND /api/instances/[id]/webui-login-url mints a signed workspace handoff
  AND the workspace iframe settles a document from the box's own gateway
      origin with a non-error status (302→200; redirect hops excluded)
```

That chain covers Clerk → entitlement → abuse gate → placement → Proxmox VM →
cloud-init → gateway → sidecar auth bridge → agent process → chat surface.

### Two rules the first proving run taught us (2026-07-08)

**1. Never gate on analytics.** The first cut proved the workspace loaded by
waiting for the dashboard's own `webui_iframe_loaded` PostHog event. Two full
runs recorded `posthog_captured: false, funnel: []` and failed at
`workspace_interactive` — reported as `category: "product"`, on boxes that were
provably healthy. A harness that reports 0/20 and blames Hivra for its own blind
spot is worse than no harness.

> **Correction (2026-07-08).** This was first attributed to canary setting no
> `NEXT_PUBLIC_POSTHOG_KEY`. That was wrong. **posthog-js silently drops every
> `capture()` from a browser it reads as a bot** — and a stock Playwright context
> is a bot on three independent signals (`HeadlessChrome` UA, `userAgentData`
> brands, `navigator.webdriver`). Remote config and `/p/flags/` sit outside that
> gate, which is exactly why the failure looked like a bad key. Same flow, only
> those signals differing: **0 ingest POSTs → 5 (13 events)**. Fixed in
> [`first-run-audit/browser-signals.ts`](first-run-audit/browser-signals.ts) and
> guarded by [`posthog-ingest.public.spec.ts`](posthog-ingest.public.spec.ts).
> Any e2e code that expects telemetry MUST create its context through
> `humanBrowserContextOptions()` + `applyHumanBrowserSignals()`.

The proof now reads the browser's network stack: the workspace iframe's own
document response — the very navigation whose completion fires the app's
`onLoad` → `trackIframeLoaded`. It is *stronger* than the event, because `onLoad`
fires even when the box serves an error page, so the old gate would have passed a
502. Telemetry is still captured and recorded in every verdict; it corroborates,
it never gates.

**2. Observe the product, don't perturb it.** Readiness is polled through
`GET /api/instances/[id]` — the route the product polls — **not** through
`/api/instances/[id]/health`. Both promote the row `provisioning → running`, but
only the former fires the post-ready `SOUL.md` reconcile (canary #484). Polling
`/health` won the race, flipped the row first, and left a freshly hired **Bea**
box wearing the factory-default Hermes soul. That was the harness's doing, not
the product's.

For the same reason the run **settles for 45s after the workspace is proven,
before teardown** (`FIRST_RUN_AUDIT_POST_READY_SETTLE_MS`). Promotion schedules
deferred work through Next's `after()`; destroying the VM the instant the iframe
paints does not merely fail to observe that work — it *aborts* it, and stamps a
`post-ready soul-seed reconcile errored` warning into the deployment log on every
run. A 20-run campaign would have manufactured 20 false incidents.

Verified live: with the settle window, a fresh Bea box's `SOUL.md` goes
`"You are Hermes Agent…"` → `"# Bea … You are **Bea**…"` ~37s after readiness.

Every run also records **`instance.inference_configured`**. On a clean-slate
deploy that is `false` — and the tally prints it. "20/20 boxes interactive,
0/20 able to answer without the user pasting a key" is a product finding, not
something the harness should hide.

The stricter `agent_replied` outcome is implemented (a real message through
`POST /api/instances/[id]/send-stream`, asserting a non-empty assistant stream).
It is off by default; enable with `FIRST_RUN_AUDIT_REQUIRE_AGENT_REPLY=1` to
check the managed inference path with the standing account's Hivra credits.

## Run it

```bash
# one audit (provisions + destroys one real canary VM)
HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp CANARY_QA_EMAIL=… npm run audit:first-run

# Replace … with the stopped run's eight-hex ID and use its standing account.
HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp CANARY_QA_EMAIL=… \
  npm run audit:first-run:cleanup -- --run-id=… --dry-run

# tally N verdict files against the 19/20 bar
npm run audit:first-run:tally
```

Run this on the approved isolated runner, not a public PR job. The spec checks
the deployed Canary site, independently of which checkout runs the harness.

## Teardown is not optional

A leaked audit VM is a paid VM and an orphan. The spec cleans up resources
named for its run through the app's own delete routes and records the result.
If teardown isn't confirmed, don't certify that run. Never delete the standing
account or unrelated resources. If recovery is authorized and the run has
stopped, inspect the exact run ID with the command above before removing
`--dry-run`.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `CANARY_QA_EMAIL` | yes | Standing QA account address from private notes. |
| `FIRST_RUN_AUDIT_BASE_URL` | no | default `https://canary.hermesos.cloud`. Non-canary hosts are hard-refused. |
| `FIRST_RUN_AUDIT_OUT_DIR` | no | default `e2e/.first-run-audit` (gitignored). |
| `FIRST_RUN_AUDIT_POST_READY_SETTLE_MS` | no | default `45000`. Dwell after the workspace is proven so the box's deferred post-ready work (SOUL.md reconcile) finishes before teardown. `0` disables. |
| `FIRST_RUN_AUDIT_CRON_SECRET` | no | enables `ops_events` collection into the verdict. |

## The verdict

Each run writes `e2e/.first-run-audit/run-<id>.json` (schema `hivra.first-run-audit.v2`):
pass/fail, `stage_reached`, `failure.{stage,category,reason}`, per-stage timings,
`instance.inference_configured`, the captured PostHog funnel (incl. every
`activation_failed` with its `stage`/`errorCategory`), any `ops_events`, and a full
teardown record. `npm run audit:first-run:tally` reads N of them and prints the pass
rate, a per-failure-stage histogram, and whether the 19/20 bar is met.

Two rules keep the number honest:
- `harness_environment` / `harness_bug` failures are **excluded** from the denominator.
- Any run that **leaked** infrastructure marks the whole campaign `NOT CERTIFIED`,
  regardless of its pass/fail verdict.

---

# LAUNCH SWEEP — every agent, launched like a customer

`launch-sweep.spec.ts` + `launch-sweep/`. For **every tile on Launch** that runs on
Hivra Cloud, it:

1. signs into the standing account with its existing Pro plan and Hivra credit;
2. opens `/dashboard/launch`, clicks the tile, clicks Review, picks **Hivra
   credits** and presses Launch;
3. waits on the after-launch screen until it says ready, then presses Open;
4. uses the proof that matches the tile: coding and chat agents answer
   "What is 389 + 448?" with `837` in the customer-visible chat surface;
   self-hosted catalog apps pass when their authenticated `/app/` web surface
   renders real app content rather than a gateway error or loopback redirect;
   computers pass when their page shows the desktop or terminal;
5. closes the agent's tab and, for `LAUNCH_SWEEP_IDLE_MINUTES` (default 10, `0`
   skips), reads what it uses idle every 30 s from the owner's own usage view
   (Manage › Overview): RAM, CPU and disk. The summary adds an **Idle use** table,
   lightest first, next to the bare Linux computer. RAM includes the guest's file
   cache, so it is an upper bound. This is what decides whether an agent can be
   offered on Free or only on Pro;
6. deletes only the run's resources through the app's own delete routes and
   leaves the account intact.

A separate test reads the live Launch page and fails if it offers a tile that
`launch-sweep/targets.ts` doesn't list, so a new agent can't ship untested.

**Cost cap.** One small Canary VM per target for ~20 minutes (10 of them idle), one at a time
(two launches at once on Canary's single host have failed at kickoff), and model use limited by the account's Hivra credit. Never retried.

**Where it runs.** Not from this repository's Actions: the public-tree rules keep
workflows bound to live infrastructure out of the public tree, and public run logs
would show Canary's internals. The reference continuous implementation is the
operator-run catalog certification runner in
`dashboard/scripts/catalog-certification/`; its operating contract is documented in
`docs/release/CATALOG-CERTIFICATION-RUNNER.md`. It serially certifies catalog entries
against the exact public Canary revision using a dedicated standing test account
and verifies teardown without deleting the account.

### Required isolated-runner setup

Use a dedicated runner with no customer shell, no production secrets and no
persistent browser profile. Node 22, `npm ci` and Playwright Chromium are the host
setup. The runner checks out the exact public `canary` merge commit being certified;
it does not deploy, promote, re-alias or otherwise mutate Vercel. The continuous
macOS runner may use the operator's authenticated Vercel CLI read-only to resolve
the served revision and fetch Canary test env values just-in-time.

Set `CANARY_QA_EMAIL` for the ordinary sweep. The certification runner sets
`CERTIFICATION_ACCOUNT_EMAIL` from its dedicated standing-account secret.
Inject the Canary-only `LAUNCH_SWEEP_SUPABASE_URL` and
`LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY` for teardown verification; no Clerk
key is needed. Set `HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp` for either run.
Model use stays bounded to the standing account's Hivra credits; do not
install a standing operator model key.

Before certifying a release, confirm through the managed-release verification
path that `canary.hermesos.cloud` serves the same Git commit the runner checked
out, then export that full lowercase SHA as `LAUNCH_SWEEP_CANARY_SHA` so every
result JSON carries it. Record the start time and the operator/runner identity
beside the sweep output. A sweep against a mismatched or unknown served revision
is only a diagnostic run, never release evidence.

First live smoke sequence, with idle measurement off until the auth path is proven:

```bash
# cheap docker-web catalog app (set LAUNCH_SWEEP_CANARY_SHA first for evidence)
LAUNCH_SWEEP_ONLY=it-tools LAUNCH_SWEEP_IDLE_MINUTES=0 npm run test:launch-sweep
# reference computer
LAUNCH_SWEEP_ONLY=ubuntu-server LAUNCH_SWEEP_IDLE_MINUTES=0 npm run test:launch-sweep
# runtime matrix pilot
LAUNCH_SWEEP_ONLY=vaultwarden,umami,nanobot,openhands LAUNCH_SWEEP_IDLE_MINUTES=0 npm run test:launch-sweep
```

The sweep verifies teardown for each run. Do not certify while cleanup is
unconfirmed. Inspect the failed verdict and recover only resources owned by
that run, never the standing account or resources from a different run.

For the Promote gate, run the customer path plus one reference agent on the
exact served SHA, then a small rotating catalog sample. Full-catalog
certification is a separate batch campaign, not the per-release gate: certify
every entry once per meaningful manifest or provisioner-runtime change, and
record pass/blocker status per manifest. Do not merge the Promote gate until
that exact-revision customer-path sweep and reference-agent launch have passed
and cleanup is clean.

```bash
export HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp CANARY_QA_EMAIL=…
export LAUNCH_SWEEP_SUPABASE_URL=… LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=…
npm run test:launch-sweep                           # everything, one at a time
LAUNCH_SWEEP_ONLY=agent-zero,openclaw npm run test:launch-sweep   # a few
npm run test:launch-sweep:summary                    # Markdown table; exits 1 if a launch is broken
```

Results land in `e2e/.launch-sweep/` (one JSON per target, plus a screenshot).
Each catalog result carries the exact manifest hash, runtime image/package
references, host port and health path from the checkout; after the customer-
visible proof it also records the owner API's live software report, which for
catalog Docker apps is normally the resolved image digest, plus the expected
provisioner bundle version, the runner checkout SHA and `LAUNCH_SWEEP_CANARY_SHA`
when supplied. A failure says the stage (`choose`, `review`, `launch`, `ready`,
`open`, `chat`) and what the screen or the agent record said. Targets marked
`knownBroken` are reported but don't fail the run.

**Adding an agent to Launch** follows `.codex/skills/hivra-add-launch-agent/SKILL.md`:
add it to `targets.ts`, launch it with the sweep, and record its idle use before
deciding Free or Pro.

# Customer path (trial to Pro, then one agent)

`e2e/trial-to-pro.spec.ts` checks billing from two pre-existing standing
Canary accounts, not from sign-up. It uses Stripe test mode:

1. The first standing billing fixture signs in, opens **Pricing**, and clicks
   **Start a 7-day free trial**.
2. It pays at Stripe Checkout with the `4242…` test card and lands back on Billing.
3. Its subscription is the trial: the entry plan with 1 agent, 1 vCPU and 2 GB,
   ending in 7 days, and Stripe shows it as `trialing` with `hivra_trial=card_7d`.
4. The trial is ended early in Stripe, so the card is charged, and the account
   becomes full Pro (3 agents, 2 vCPU, 4 GB, no trial end date).
5. The Pro account launches one reference agent from Launch
   (`CUSTOMER_PATH_AGENT`, default `claude-code`), gets a real reply, sleeps and
   wakes it, gets another reply, and deletes it. `CUSTOMER_PATH_AGENT=none`
   skips this part.
6. A second account using the same card gets no trial: the webhook cancels
   that trial without charging, and the account gets no plan.
7. The second account checks out again from **Pricing**. This time it is paid
   checkout with no trial: the card is charged at once and the account becomes
   full Pro.

The fixture addresses go in `TRIAL_JOURNEY_FIRST_EMAIL` and
`TRIAL_JOURNEY_REPEAT_EMAIL`. These must be dedicated standing billing
fixtures, distinct from each other and from the shared Pro account, with no
subscription, trial history or computers. If eligible fixtures aren't
available, leave the journey blocked. Don't create accounts, strip an
existing account's plan, or repurpose a tenant-isolation or operator fixture.

The journey launches at most one computer. It verifies ownership before
cleaning up run-created resources and test billing state, never the accounts.
Unconfirmed cleanup fails the journey; don't rerun it until the previous
run's resources are accounted for.

It needs the card trial on Canary (`HIVRA_CARD_TRIAL=on` and its migration) and
is opt-in: it runs only with `TRIAL_JOURNEY=1` against Canary, with a Stripe
test key. It's never retried, because a retry would start another checkout.

```bash
HIVRA_LIVE_AUDIT_AUTH=clerk-test-otp TRIAL_JOURNEY_FIRST_EMAIL=… TRIAL_JOURNEY_REPEAT_EMAIL=… \
  LAUNCH_SWEEP_SUPABASE_URL=… LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… \
  TRIAL_JOURNEY_STRIPE_SECRET_KEY=sk_test_… npm run test:trial-journey
```
