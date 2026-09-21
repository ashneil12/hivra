# PostHog Product Triage — 2026-05-24

## Source

AEON `posthog-session-analyzer` recent capped snapshot:

- 50 recordings
- 200 events
- 63 exceptions
- 50 sampled persons
- funnels unavailable due `fetch_failed`

No raw person identifiers belong in this doc.

## Verdict

**ACTION.** The product has three near-term leaks that matter more than new surface area:

1. Wallet RPC failures.
2. Activation stall.
3. Welcome dead-click/repair confusion.

Privacy instrumentation also needs tightening before PostHog becomes a normal operating loop.

## Finding 1 — Wallet RPC failures

Observed:

- `/dashboard/wallet` is the exception epicenter.
- 36/63 exceptions are wallet-bound.
- All 21 `RpcResponse.InternalError` exceptions are wallet/RPC path failures.

Likely impact:

- Trust loss at the exact moment users inspect token/access/payment state.
- Blocks paid/token confidence even if billing itself works.

Likely code surfaces:

- `dashboard/src/app/dashboard/wallet/page.tsx`
- `dashboard/src/app/api/billing/wallet/eligibility/route.ts`
- `dashboard/src/app/api/billing/wallet/unlock/route.ts`
- `dashboard/src/lib/billing/token-holding-snapshots.ts`
- `dashboard/src/lib/billing/venice-compute-boost.ts`
- Bankr/Base RPC helpers if present.

Fix plan:

- [ ] Add correlation IDs and safe error classes around wallet RPC calls.
- [ ] Fail soft in UI with a retry state, not a broken dashboard.
- [ ] Add fallback/read-through behavior where RPC failure should not block viewing current account state.
- [ ] Add tests for RPC internal error, timeout, missing wallet, and malformed response.
- [ ] Confirm no token-price or inducement copy is introduced while fixing UX.

Owner routing:

- Aquinas implements.
- Anselm reviews finance/risk wording.
- Augustine gates if any wallet/payment behavior changes.

## Finding 2 — Activation stall

Observed:

- 22/50 sampled signups, roughly 44%, last seen at `/get-started/activate` and did not reach dashboard in the capped sample.

Likely impact:

- Highest conversion leak in current funnel.
- Could be a product-capacity issue, unclear CTA, instance provisioning wait, auth/session mismatch, or user confusion.

Likely code surfaces:

- `dashboard/src/app/get-started/activate/page.tsx`
- `dashboard/src/app/api/instances/route.ts`
- `dashboard/src/components/dashboard/welcome/WelcomeFlow.tsx`
- `dashboard/src/components/dashboard/welcome/DeployingState.tsx`
- `dashboard/src/lib/services/instance-service.ts`
- `dashboard/src/lib/services/proxmox-instance-service.ts`

Fix plan:

- [ ] Instrument activation outcome events: `activation_started`, `activation_instance_requested`, `activation_instance_ready`, `activation_failed`, `activation_dashboard_reached`.
- [ ] Split stalls by cause: auth missing, capacity wait, deploy in progress, deploy failed, user abandoned.
- [ ] Add visible progress/recovery state on activate page.
- [ ] Add retry/resume path if an instance exists but dashboard navigation failed.
- [ ] Add test coverage for stalled deploy, successful existing instance, and recoverable failure.

Owner routing:

- Aquinas implements instrumentation and state fixes.
- Benedict verifies deploy/provisioning side effects.
- Chrysostom rewrites UX copy if the problem is comprehension.

## Finding 3 — Welcome dead-click and repair confusion

Observed:

- Rageclicks on `/dashboard/welcome`.
- `REPAIR/REBUILD RUNTIME` clicks indicate users see instability controls or recovery paths.

Likely impact:

- Users are landing in a state where the next action is unclear or controls are not responding.
- Repair/rebuild language can scare new users before they understand the product.

Likely code surfaces:

- `dashboard/src/components/dashboard/welcome/WelcomeFlow.tsx`
- `dashboard/src/components/dashboard/welcome/DeployingState.tsx`
- `dashboard/src/components/dashboard/welcome/DeployedCelebration.tsx`
- `dashboard/src/app/workspace-cloud/connect/connect-client.tsx` if related to Workspace Cloud handoff.

Fix plan:

- [ ] Reproduce with session replay timestamps, not raw PII.
- [ ] Audit disabled/loading buttons and click handlers.
- [ ] Replace scary recovery labels in onboarding with plain progress/retry language.
- [ ] Add event for dead-click candidate controls.

Owner routing:

- Chrysostom owns copy/friction diagnosis.
- Aquinas implements UI fix.

## Privacy fixes before broader PostHog usage

Observed:

- Recordings are live on wallet, billing, settings, sign-in, and activation pages.
- `.posthog-cache/` had raw person data in AEON cache. AEON gitignore was already fixed, but source instrumentation still needs privacy review.

Fix plan:

- [ ] Disable or mask session recording on wallet, billing, settings, sign-in, and activation unless explicitly needed for a short debug window.
- [ ] Add PostHog property scrubbing for emails, names, wallet addresses, tokens, invite codes, and auth/error payloads.
- [ ] Keep AEON PostHog outputs aggregate-only. No raw person identifiers in context, commits, or Discord.
- [ ] Repair funnels prefetch query so future runs can measure conversion directly.

Owner routing:

- Benedict reviews privacy/security posture.
- Aquinas implements instrumentation and tests.
- Augustine approves any broad analytics change before prod.

## Implementation order

1. Wallet RPC failure handling.
2. Activation stall instrumentation and recovery path.
3. Welcome dead-click/copy fix.
4. PostHog privacy masking and funnel prefetch repair.

## Acceptance criteria

- Wallet page no longer throws uncaught RPC exceptions in PostHog for common RPC failures.
- Activation page emits outcome events with enough labels to classify stalls.
- Welcome page has no known rage-click target with missing handler or invisible disabled state.
- Session recordings are masked/disabled on sensitive pages.
- AEON PostHog analyzer can produce a funnel-aware report without raw PII.
