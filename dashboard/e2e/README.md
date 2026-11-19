# Dashboard E2E — Tier 1 of the QA pyramid

Deterministic Playwright smoke + **visual regression (VRT)** against a deployed
target. This is the cheap, broad net that runs on every PR so the routine "a
route 500s" / "the deploy button broke" class gets caught without anyone
clicking around. (Tiers 2–3 — AI-generated + agentic browser QA — live in the
`hermes-qa-swarm` harness.)

## Layout
- `public.public.spec.ts` — logged-out routes render (HTTP < 400 + real content) + VRT.
- `golden-deploy.authed.spec.ts` — the **login → dashboard → deploy** golden path. Skips if no QA session.
- `first-run-audit.spec.ts` + `first-run-audit/` — the **19/20 gate**. Real provisioning. See below.
- `global-setup.ts` — mints a Clerk sign-in ticket for the QA user and saves an authed storage state.
- `playwright.config.ts` (repo root of `dashboard/`) — projects: `public` (no auth), `authed` (storage state),
  and `first-run-audit` (only exists when `FIRST_RUN_AUDIT=1`).

## Run it
```bash
npm run test:e2e            # all, against E2E_BASE_URL (default https://canary.hermesos.cloud)
npm run test:e2e:public     # public smoke + VRT only (no secrets needed)
E2E_BASE_URL=https://<vercel-preview>.vercel.app npm run test:e2e   # gate a PR preview
```

## Env (authed path only)
- `CLERK_SECRET_KEY` — Backend API key for the **canary** Clerk instance (`splendid-longhorn-99`).
- `QA_USER_ID` — the `qa-agent@hermesos.cloud` Clerk user id.

Without them, `global-setup` no-ops and the authed specs skip — public smoke + VRT still run.

## VRT baselines
Screenshots are OS-sensitive — **generate baselines on the Linux CI runner**, never commit
macOS-generated ones. First-time / refresh:
```
gh workflow run dashboard-e2e.yml -f update_snapshots=true   # uploads baselines as an artifact
```
Commit the artifact's `*-snapshots/` into `dashboard/e2e/` once, then VRT gates real diffs.

## TODOs before the authed path is fully green
- Replace the placeholder selectors in `golden-deploy.authed.spec.ts` with stable `data-testid`s.
- ~~Decide the deploy assertion's safe stopping point~~ — settled: `golden-deploy` stays **assert-only** (it
  runs on every PR), and the real click lives in the opt-in `first-run-audit` spec below.

---

# FIRST-RUN AUDIT — the 19/20 gate

> "new signup → first agent deployed → first real outcome, working clean
> 19 out of 20 times, zero manual intervention." — the bar that gates the
> reactivation campaign and Product Hunt.

**This is the only test in the repo that provisions real, paid infrastructure.**
One Proxmox VM on the canary host per run. It is double-gated and can never fire
on an ordinary CI push:

1. `playwright.config.ts` only *defines* the `first-run-audit` project when `FIRST_RUN_AUDIT=1`.
2. The spec itself `test.skip`s unless the same var is set.

## What "first real outcome" means here

A virgin free account **cannot** reach an agent that answers a question today:

- **Managed (Venice)** — the deploy card's default — early-returns an unfunded
  account into a wallet-funding screen. The Deploy button isn't even rendered.
- **"Bring your own"** deploys a *clean-slate* box: no provider, no model, no key.
  The card's own copy says "paste your key from the agent after it's live."

So the audit certifies what the product actually promises a new user —
**your agent exists, it booted, and you can sit down and type to it** — as
`workspace_interactive`:

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
It is off by default; enable with `FIRST_RUN_AUDIT_REQUIRE_AGENT_REPLY=1` once a
new user has a path to a box that boots with inference configured.

## Run it

```bash
# one audit (provisions + destroys one real canary VM)
CLERK_SECRET_KEY=sk_test_… npm run audit:first-run

# reap anything a crashed run left behind — ALWAYS run this after a campaign
CLERK_SECRET_KEY=sk_test_… npm run audit:first-run:cleanup
CLERK_SECRET_KEY=sk_test_… npm run audit:first-run:cleanup -- --dry-run

# tally N verdict files against the 19/20 bar
npm run audit:first-run:tally
```

In CI: **`first-run-audit.yml`**, `workflow_dispatch` only, or by adding the
`first-run-audit` label to a PR. Never on push, never on `schedule`, never on
`pull_request_target`, never on a plain PR event. A fork PR carries no secrets,
so the workflow's Clerk guard exits non-zero before anything is provisioned.
(The label path still audits the **deployed canary**, not the PR's code — the
suite targets a URL, not a build. That is what you want when the PR *is* the
harness.)

## Teardown is not optional

A leaked audit VM is a paid VM and an orphan. Four nets, in order:

1. the spec's `finally` — destroys via the app's own confirm-gated `DELETE /api/instances/[id]`
2. the spec's `afterAll` — catches a Playwright **timeout**, which aborts the test body and skips its `finally`
3. `scripts/first-run-audit-cleanup.ts` — reaps by `firstrun-audit-` email prefix
4. the workflow's `if: always()` cleanup step, which exits non-zero on any survivor

Proven on 2026-07-08 across four real canary provisions — including two that
**failed** mid-run, which is the case that matters. After each: `qm list` back to
baseline, no `vm-<id>` logical volumes, the box's Caddy vhost removed, its
Cloudflare DNS record deleted, and the Clerk user returning `404`.

If an instance cannot be destroyed, the Clerk user is deliberately **kept** — without
them nothing can authenticate to finish teardown through the app's own destroy path.

## Env

| Var | Required | Notes |
| --- | --- | --- |
| `CLERK_SECRET_KEY` | yes | **canary** (`sk_test_…`). An `sk_live_` key is hard-refused. |
| `FIRST_RUN_AUDIT_BASE_URL` | no | default `https://canary.hermesos.cloud`. Non-canary hosts are hard-refused. |
| `FIRST_RUN_AUDIT_OUT_DIR` | no | default `e2e/.first-run-audit` (gitignored). |
| `FIRST_RUN_AUDIT_POST_READY_SETTLE_MS` | no | default `45000`. Dwell after the workspace is proven so the box's deferred post-ready work (SOUL.md reconcile) finishes before teardown. `0` disables. |
| `FIRST_RUN_AUDIT_CRON_SECRET` | no | enables `ops_events` collection into the verdict. |
| `FIRST_RUN_AUDIT_PRECLEAR_RISK` | no | see below. Requires the two Supabase vars. |
| `FIRST_RUN_AUDIT_SUPABASE_URL` / `…_SERVICE_ROLE_KEY` | no | canary only. |

### The datacenter-IP problem

`src/lib/abuse/risk-scorer.ts` scores `IS_DATACENTER` at **+30** → tier `medium`
→ decision `require_card`. Every hosted CI runner egresses from a datacenter ASN,
so an unaided CI audit would fail 20/20 at the abuse gate for a reason **no real
user on a home connection ever hits** — it would be measuring the runner's network
reputation, not Hivra.

- From a laptop (residential IP): score 0 → `allow`. Nothing needed.
- From CI: set `FIRST_RUN_AUDIT_PRECLEAR_RISK=1` + the canary Supabase vars. The
  harness writes one `signup_risk_assessments` row (`decision=allow`) for the
  throwaway user and deletes it in teardown. It does not disable the gate or touch
  any real user.
- Without it, a `card_required` response is recorded as a **`harness_environment`**
  failure — excluded from the bar and reported loudly, never silently passed.
  Detected off the deploy POST's own `402`, not off analytics (see rule 1 above);
  the `activation_card_required` event never reaches us on canary.

> **Today this is dormant, not wrong.** The canary Vercel project sets neither
> `PROXYCHECK_API_KEY` nor `FINGERPRINT_SECRET_KEY`, and both providers degrade to
> *neutral* when unconfigured — so on canary the scorer returns 0 for everyone and
> the gate allows, datacenter runner or not. The preclear is the correct answer the
> day either key is added to canary, and the four proving runs on 2026-07-08 needed
> none of it. Corollary: **this audit does not exercise the real production abuse
> gate.** It cannot, and it should not pretend to.

## The verdict

Each run writes `e2e/.first-run-audit/run-<id>.json` (schema `hivra.first-run-audit.v1`):
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
Hivra Cloud, in its own throwaway Canary account, it:

1. creates a Clerk test user and gives it the Pro plan (the one shortcut: the
   subscription row is written instead of paying through Stripe);
2. signs in, opens `/dashboard/launch`, clicks the tile, Review, picks **Hivra
   credits** (the starter credit every new paid account gets) and presses Launch;
3. waits on the after-launch screen until it says ready, then presses Open;
4. asks "What is 389 + 448? Reply with only the number." in the box a customer
   types into (Hivra's chat for Claude Code and Codex, the agent's own web UI
   for the rest) and waits for `837` on screen. Computers pass when their page
   shows the desktop or terminal;
5. closes the agent's tab and, for `LAUNCH_SWEEP_IDLE_MINUTES` (default 10, `0`
   skips), reads what it uses idle every 30 s from the owner's own usage view
   (Manage › Overview): RAM, CPU and disk. The summary adds an **Idle use** table,
   lightest first, next to the bare Linux computer. RAM includes the guest's file
   cache, so it is an upper bound. This is what decides whether an agent can be
   offered on Free or only on Pro;
6. deletes everything through the app's own delete routes, then the account.

A separate test reads the live Launch page and fails if it offers a tile that
`launch-sweep/targets.ts` doesn't list, so a new agent can't ship untested.

**Cost cap.** One small Canary VM per target for ~20 minutes (10 of them idle), one at a time
(two launches at once on Canary's single host have failed at kickoff), and model use limited by the account's starter credit. Never retried.

**Where it runs.** Not from this repository's Actions: the public-tree rules keep
workflows bound to live infrastructure out of the public tree, and public run logs
would show Canary's internals. The schedule (weekly, and before every release into `main`) runs from a private
operations runner that checks out this repository and runs the commands below with
the Canary test credentials.

```bash
CLERK_SECRET_KEY=sk_test_… LAUNCH_SWEEP_SUPABASE_URL=… LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… \
  npm run test:launch-sweep                         # everything, one at a time
LAUNCH_SWEEP_ONLY=agent-zero,openclaw npm run test:launch-sweep   # a few
LAUNCH_SWEEP_KEEP_FAILED=1 …                         # keep a failed computer to read its logs
LAUNCH_SWEEP_KEEP_PASSED=claude-code,codex …         # keep these after a pass, to read inside them
npm run test:launch-sweep:summary                    # Markdown table; exits 1 if a launch is broken
npm run audit:first-run:cleanup                      # reaps any leftover sweep accounts too
```

Results land in `e2e/.launch-sweep/` (one JSON per target, plus a screenshot).
A failure says the stage (`choose`, `review`, `launch`, `ready`, `open`, `chat`)
and what the screen or the agent record said. Targets marked `knownBroken` are
reported but don't fail the run.

**Adding an agent to Launch** follows `.codex/skills/hivra-add-launch-agent/SKILL.md`:
add it to `targets.ts`, launch it with the sweep, and record its idle use before
deciding Free or Pro.

# Trial to Pro journey

`e2e/trial-to-pro.spec.ts` checks the paid path a new customer takes, in a real
browser on Canary with Stripe in test mode:

1. A throwaway account opens **Pricing** and clicks **Start a 7-day free trial**.
2. It pays at Stripe Checkout with the `4242…` test card and lands back on Billing.
3. Its subscription is the trial: the entry plan with 1 agent, 1 vCPU and 2 GB,
   ending in 7 days, and Stripe shows it as `trialing` with `hivra_trial=card_7d`.
4. The trial is ended early in Stripe, so the card is charged, and the account
   becomes full Pro (3 agents, 2 vCPU, 4 GB, no trial end date).
5. A second account using the same card gets no trial: it is charged at once
   and goes straight to full Pro.

Every account, Stripe subscription and customer, and trial record it made is
deleted at the end, pass or fail. It launches no computers.

It needs the card trial on Canary (`HIVRA_CARD_TRIAL=on` and its migration) and
is opt-in: it runs only with `TRIAL_JOURNEY=1`, refuses production and refuses
live Clerk or Stripe keys. Never retried, because a retry would start a second checkout.

```bash
CLERK_SECRET_KEY=sk_test_… LAUNCH_SWEEP_SUPABASE_URL=… LAUNCH_SWEEP_SUPABASE_SERVICE_ROLE_KEY=… \
  TRIAL_JOURNEY_STRIPE_SECRET_KEY=sk_test_… npm run test:trial-journey
```
