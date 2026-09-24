# Hivra pre-launch security review — 2026-09

**Status:** findings report. Review performed against `origin/canary` (base `05c0c5d`;
canary advanced to `08d2ff1` during the review, a docs/UI-only delta). Canary served
SHA at review time: `08d2ff1` (Vercel Git deployment `dpl_Vv8jesp2ZG28cxoGDmYRhaA7uKUP`,
project `hermesos-canary`).

**Method.** Thirteen area reviewers fanned out (money paths A–D, key custody,
AuthN/Z + tenant isolation across `instances/`, `hivra/`, platform/ops, and all 62 cron
routes, Supabase RLS/grants, agent boxes + gateway + SSRF, secrets/repo hygiene, web).
Findings were traced to `file:line` and self-refuted before inclusion. Database checks
were **read-only** catalog/log queries on canary (`srrwbdvx…`) and prod (`prvdajgv…`);
no rows of customer data were read and nothing was written. No live/network probing of
Hivra domains was performed (the container's egress policy blocks `*.hermesos.cloud`;
recorded as a gap).

> **This session produced findings only. No fix PRs were merged.** Every finding below
> is **OPEN**. See the companion handoff `docs/security/PRE-LAUNCH-REVIEW-2026-09-HANDOFF.md`
> for the recommended fix order and reproduction proofs. Fixes, regression tests, and the
> served-on-canary confirmation required by the task's acceptance boundary (b) remain to
> be done.

Severity reflects **real exploitability on canary/prod today** where it could be
established. Several high-impact items are gated behind a production configuration flag
or an unverified precondition (Vercel env, Supabase auth settings) that this session could
not read; those are marked and also listed under **Needs Ash**.

---

## Actively-exploitable — fix before Promote

### [CRITICAL] Managed-Venice media & passthrough proxy spend Hivra's Venice credits with no balance/reservation check — OPEN
- **Location:** `dashboard/src/app/api/managed-venice/keys/route.ts:56-95` (mints an `active`
  key for any signed-in user, only `auth()` + rate-limit); `dashboard/src/lib/venice/proxy-keys.ts:217-314`
  (mint has no balance/plan gate) and `:334-374` (verify checks only `status==='active'`);
  `dashboard/src/app/api/managed-venice/v1/[...path]/route.ts:60-196` (verifies key, then
  forwards **any** path to `https://api.venice.ai/api/v1/<path>` with the platform upstream
  key — no reservation/balance call); `dashboard/src/app/api/managed-venice/v1/images/generate/route.ts:42-166`
  and every other `v1/images/*`, `v1/videos/*`, `v1/audio/*`, `v1/embeddings`, `v1/augment/*`
  route (same shape; grep found no reserve/balance call); `dashboard/src/lib/venice/proxy-settlement.ts:435-475`
  records usage with `charged=0, status='reconciliation_required'`; multimodal billing is a
  dry-run unless `MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED=true`, and even then an
  unfunded wallet only files a reconciliation item with `pauseKey:false`.
- **Attacker & preconditions:** any free Clerk account (`$0` wallet).
- **Exploit:** `POST /api/managed-venice/keys` → loop `POST /api/managed-venice/v1/video/queue`
  (or `image/generate`, `audio/queue`, …) with expensive models, retrieve results.
- **Impact:** unbounded spend on Hivra's shared Venice account; exhausting it is a managed-Venice
  outage for every paying user.
- **Confidence:** high (VERIFIED by code read; the `keys` mint and `[...path]`/`images` verify-only
  gating were re-confirmed by the lead).
- **Fix:** require an available-balance reservation from a conservative per-endpoint estimate
  before forwarding on every media and passthrough route; allowlist passthrough paths; refuse
  key mint / media use for unfunded accounts.
- **Regression test:** a `$0`-balance key calling `v1/image/generate` and `[...path]` `video/queue`
  returns 402 and `fetch` is never called.

### [HIGH] Chat-completions stream refunds the whole hold on client disconnect → free chat inference — OPEN
- **Location:** `dashboard/src/app/api/managed-venice/v1/chat/completions/route.ts:120-126`
  (`cancel()` → `releaseManagedVeniceChatReservation`), capture only after upstream `done`
  (`:58-105`); `dashboard/src/lib/billing/managed-venice-wallets.ts:348-375`;
  `dashboard/src/lib/venice/reservation-sweep.ts:24-28,153-220` (sweep closes the aborted
  reconciliation items as "already released"). Contrast the correct
  `dashboard/src/app/api/managed-venice/v1/responses/route.ts:138-144`.
- **Attacker:** any key whose wallet holds ≥1 reservation (e.g. a $0.50 starter credit).
- **Exploit:** call `…/v1/chat/completions` with `stream:true`, read content, close the
  connection just before the final usage frame; the hold is released each time, so balance
  never drops.
- **Impact:** unlimited chat inference paid by Hivra (works even with the Cloudflare worker in
  front — the Vercel route stays public).
- **Confidence:** high (VERIFIED; scratch jest proof gave release=1, capture=0).
- **Fix:** on cancel, keep the hold (or capture a bytes/tokens estimate) and file a
  non-sweepable reconciliation item; never release after upstream returned 200 (mirror the
  Responses route).

### [HIGH] Managed-Venice `[...path]` passthrough exposes Venice account-management endpoints under Hivra's key — OPEN (impact conditional on upstream key type)
- **Location:** `dashboard/src/app/api/managed-venice/v1/[...path]/route.ts:60-71,112-127,198-212`
  (only blocks traversal and `responses`; forwards GET+POST). Consumers hold the key in-box
  as `VENICE_API_KEY`.
- **Exploit:** `GET .../v1/api_keys/rate_limits`, `GET .../v1/api_keys`, `GET .../v1/billing/usage`,
  `POST .../v1/api_keys`.
- **Impact:** discloses Hivra's Venice account balance/limits/key list; **if the upstream key is
  an ADMIN key, any user can mint unmetered Venice keys billed to Hivra.**
- **Confidence:** high (code) / medium (impact — depends on `VENICE_API_KEY`/pool key type; see
  Needs Ash).
- **Fix:** replace the catch-all with an explicit allowlist of generation/read/model paths;
  reject `api_keys*`, `billing*`; confirm INFERENCE-only upstream keys.

### [HIGH] `/clerk-assets/:path*` rewrite serves any npm package from the dashboard origin → stored XSS / account takeover — OPEN (jsDelivr Content-Type unverified)
- **Location:** `dashboard/next.config.ts:215-223` (`/clerk-assets/:path*` → `https://cdn.jsdelivr.net/npm/:path*`,
  not scoped to `@clerk/*`); the document CSP is **report-only** (`next.config.ts:287,295`).
- **Attacker:** anyone who can publish an npm package; victim only needs to open one link while
  signed in.
- **Exploit:** publish `evil-pkg` containing an `.svg`/`.xml` with an inline `<script>`; send the
  victim `https://hivra.cloud/clerk-assets/evil-pkg@1.0.0/x.svg`. Vercel proxies jsDelivr's
  Content-Type under the hivra.cloud origin, so the script runs same-origin and can call any
  authenticated API (incl. `…/bankr-wallet/withdraw` with an attacker recipient).
- **Confidence:** medium-high (rewrite scope VERIFIED; needs jsDelivr to serve `.svg` as
  `image/svg+xml` without its own CSP — confirm with one `curl -sI`).
- **Fix:** narrow the source to `@clerk/(clerk-js|ui)@<ver>/dist/...`, add
  `Content-Security-Policy: sandbox` on `/clerk-assets/(.*)`, or self-host the two pinned bundles;
  and move the document CSP from report-only to an enforced nonce CSP.

---

## High — fix before Promote (some gated by prod config)

### [HIGH] Workspace-Cloud `invoice.paid` cross-lane activates an abandoned Hivra paid-plan row → free Fleet/Command tier — OPEN (gated on WC prices configured in prod)
- **Location:** `dashboard/src/app/api/webhooks/stripe/route.ts:131-136` routes
  `invoice.paid`/`payment_failed` to `StripeWebhookService` **without** the
  `isWorkspaceCloudSubscription` check that `subscription.*`/`checkout.*` have (`:105,115,124`);
  `dashboard/src/lib/services/stripe-webhook-service.ts:1630-1687` (`handleInvoicePaid` sets
  `hermes_subscriptions.status='active'` by `metadata.user_id`, no check that
  `stripe_subscription_id` matches the row); `dashboard/src/app/api/billing/subscribe/route.ts:62-89,550-560`
  writes a `pending` row already carrying the target plan's limits;
  `dashboard/src/lib/billing/instance-entitlement.ts:179-190` grants that plan for any `active`
  paid row; reconciler only sends to `manual_review` (`subscription-state-reconciler.ts:358-361`).
- **Exploit:** `POST /api/billing/subscribe {plan:fleet}` (don't pay) → subscribe+pay
  Workspace-Cloud Pro → its `invoice.paid` flips the Hivra row to `active` → Fleet tier (5 VMs)
  for the price of WC Pro; every WC renewal re-asserts it. Reverse: a WC `payment_failed`
  suspends the victim's Hivra instances.
- **Confidence:** high (code; scratch jest proof) / medium (prod exploitability — needs WC prices
  configured; `WORKSPACE_CLOUD_*_PRICE_ID` / `WORKSPACE_CLOUD_ALLOW_SHARED_PRICE`, see Needs Ash).
- **Fix:** skip WC subscriptions in `handleInvoicePaid`/`handlePaymentFailed` (route them to the WC
  handler), and only update `hermes_subscriptions` where `stripe_subscription_id = subscriptionId`.

### [HIGH] Token-tier eligibility becomes permanent once a user's first crypto-payment wallet is set primary → permanent Power tier + Sybil rotation — OPEN
- **Location:** `dashboard/src/lib/billing/bankr-deposit-wallets.ts:471` (`makePrimary ?? true`);
  `dashboard/src/lib/billing/bankr-wallets.ts:442-452` (clears `is_primary` on all the user's EVM
  wallets, promotes the Bankr `credit_deposit` row); callers default `makePrimary:true` at
  `billing/bankr/wallet/route.ts:60-64`, `billing/crypto/top-up/route.ts:74-78`,
  `billing/yearly-token-quote/route.ts:280-284`, `billing/managed-venice/hermesos/quote/route.ts:181-184`.
  `getTokenVerificationWallet` then returns null for a `credit_deposit` primary
  (`token-holdings.ts:340-352,688-725`), so the 6-hourly cron reports `no_verified_wallet` and
  never re-evaluates, while `instance-entitlement.ts:266-300` keeps granting `currently_eligible`.
- **Exploit:** verify a wallet holding the Power threshold → `/wallet/unlock` (inserts an eligible
  row) → make any crypto payment (demotes the verified wallet) → sell tokens; the tier is now
  permanent, and one token pile rotates across unlimited Sybil accounts.
- **Confidence:** high (VERIFIED by code + existing unit tests).
- **Fix:** provision `credit_deposit` with `makePrimary:false` everywhere (and change the default);
  in the holdings cron, treat "has eligible qualification rows but no eligible verification wallet"
  as a breach (zero balance), like `revokeDisplacedTokenEntitlements` already does.

### [HIGH] Holdings crons only refresh the 100 oldest primary wallets → later tier holders never re-evaluated — OPEN (prod row count unverified)
- **Location:** `dashboard/src/lib/billing/token-holdings.ts:206-209` (limit capped at 100),
  `:907-914` (`is_primary=true … ORDER BY verified_at ASC … LIMIT`, no cursor); callers
  `cron/refresh-token-holdings/route.ts:28-33,70` and `cron/refresh-token-tiers/route.ts:101-104`.
  Every crypto-billing user adds a primary `credit_deposit` row (see finding above) that consumes
  a slot without being evaluated.
- **Impact:** once >100 primary verified wallets exist, users past position 100 are never downgraded
  when they sell — permanent paid tier — and new holders are never auto-qualified.
- **Confidence:** high (code) / medium (needs prod row count).
- **Fix:** paginate by cursor / `last_evaluated_at ASC NULLS FIRST`, drive the loop from users with
  qualification/boost rows, exclude ineligible `credit_deposit` rows.

### [HIGH] Platform `GHCR_TOKEN` shipped into tenant VMs and left in docker credentials → tenant root reads it; write scope = fleet compromise — OPEN (token scope unverified)
- **Location:** `dashboard/src/lib/services/webui-instance-builder.ts:4064-4066` (`docker login ghcr.io`
  with `GHCR_TOKEN` inside the tenant VM bootstrap); `dashboard/src/lib/services/hetzner-instance-builders.ts:2148-2156`;
  `dashboard/src/app/api/instances/[id]/route.ts:862` passes the token; on Hetzner it lands in
  `user_data`. No `docker logout` anywhere.
- **Exploit:** owner enables root access → `docker run -v /:/h alpine cat /h/root/.docker/config.json`
  → base64-decode the token; on Hetzner also readable via the metadata service.
- **Impact:** with `write:packages`, push a malicious `hermes-webui:stable`/`vanilla-hermes-agent:stable`
  that every box pulls = fleet-wide compromise; with read-only, private-image exposure.
- **Confidence:** high (code path) / medium (impact depends on token scope — see Needs Ash).
- **Fix:** make images public or pull host-side/via proxy; if login is required use a fine-grained
  `read:packages` token and `docker logout` + delete `~/.docker/config.json` after the pull; never
  put the token in `user_data`.

### [HIGH] Hermes-lane Bankr keys sent over unpinned SSH to the stored guest IP → ARP-spoof on a shared Proxmox bridge steals a neighbour's wallet key — OPEN (host network config unverified)
- **Location:** `dashboard/src/lib/services/instance-orchestrator.ts:710-751` (runtime update:
  `rm -f known_hosts` + `StrictHostKeyChecking=accept-new` to `$PRIVATE_IP`, no VMID tag / ipconfig /
  host-key check) carrying the Bankr config (`:340-351,531,607`; `webui-instance-builder.ts:2546-2673,2751`);
  same accept-new pattern in `dashboard/src/lib/hetzner/ssh.ts:121-150` reached by
  `hermes-config-write.ts:86-110`. The **Hivra lane** does this correctly
  (`hivra/bankr-wallet-env-seed.ts:81-101`, `vmid-bound-guest-ssh.ts:27-43`: owner tag + configured
  IP + QGA-attested host key).
- **Exploit:** a Hermes tenant with root on a Proxmox host shared with a victim ARP-spoofs the
  victim's private IP, runs an sshd that logs stdin; the victim's next runtime update (probe-driven
  recovery, redeploy cron, or their own Update) streams the bootstrap incl. `BANKR_API_KEY` to the
  attacker. Hivra-provisioned agent-wallet keys have no recipient allowlist → drainable to any address.
- **Confidence:** medium (missing pinning certain; exploitability depends on Proxmox bridge/anti-spoof
  config not in the repo).
- **Fix:** reuse the Hivra-lane checks (tag + `ipconfig0` + QGA host-key pin, or `qm guest exec`)
  before any Hermes-lane SSH that carries secrets; enable Proxmox `firewall=1` with ipfilter/macfilter
  on tenant NICs.

### [HIGH] An `authenticated` Supabase JWT can write `hermes_instances` (RLS `ALL` policy) → purge cron deletes an arbitrary Hetzner server; self-escalate tier/gateway — OPEN (conditional on an authenticated-JWT source being enabled)
- **Location:** policy `hermes_instances "users manage own instances"` (role `{authenticated}`,
  cmd `ALL`, `qual=with_check=(requesting_user_id()=user_id)`) — present on **both** canary and prod;
  `authenticated` holds INSERT/UPDATE/DELETE by default grant; no column-guard trigger.
  `cron/purge-expired/route.ts:141-158` selects `status='scheduled_for_deletion'` (and stranded rows)
  and calls `deleteServer(hetzner_server_id)` (`lib/hetzner/client.ts:1207-1208`) with no ownership
  check. The same `ALL` policy exists on `hermes_hosts`, `profiles`, `user_api_keys`,
  `hermes_conversations/messages`.
- **Precondition:** the attacker must obtain a JWT with `role=authenticated` — via Supabase GoTrue
  signup / anonymous sign-in, or Clerk third-party auth, or a Clerk JWT template signed with the
  Supabase secret. **No code path today uses a user JWT** (`lib/supabase.ts` builds the anon client
  with no `accessToken`; edge logs show 100% service-role REST traffic), and `config.toml` sets
  `[auth.third_party.clerk] enabled=false` (local-only file). Prod `auth.users` shows 15 rows,
  0 sessions.
- **Confidence:** high (policy + code path VERIFIED) / **unknown precondition** — critical if any
  authenticated-JWT source is enabled in the Supabase dashboard, latent otherwise. See Needs Ash.
- **Fix:** drop the unused `authenticated`/`anon`/`public` write policies on public tables; revoke
  default INSERT/UPDATE/DELETE from `anon`/`authenticated`; disable GoTrue signup + anonymous
  sign-ins on both projects; make `purge-expired` refuse to delete when the row's `user_id` does not
  resolve to a known Clerk user.

---

## Medium

- **[MEDIUM] Managed-Venice overage — no `max_tokens` reservation → ~31× spend amplification.** Without
  `max_tokens`, only 4,096 output tokens are reserved (`venice/cost-estimator.ts:34,143-147`); overage
  debit throws and only the one key is paused, trivially re-minted (`proxy-settlement.ts:208-334`).
  VERIFIED. Fix: reserve against the model's max output; block the **account**, not just the key,
  while uncovered debt is open.
- **[MEDIUM] Token-lot debit race** (`managed-venice-wallets.ts:382-430` `debitHermesosLots`: absolute
  `SET` with `.eq("id")`, no CAS/lock) → concurrent captures collapse into one → free usage. VERIFIED
  (10 concurrent $0.10 debits vs $1.00 left $0.90). Fix: `UPDATE … SET remaining = remaining - x WHERE
  remaining >= x` under a per-user advisory lock.
- **[MEDIUM] Top-up reconcile starvation.** `crypto-reconciliation.ts:126-150` loads only the 50 newest
  pending intents; the "one open session" check is check-then-insert with no unique index
  (`crypto-payment-sessions.ts:206-233`); no rate limit on the top-up route. A burst (or a few Sybils)
  before each 10-min tick starves every other user's USDC settlement. VERIFIED PoC. Fix: partial unique
  index / advisory-lock RPC, rate-limit, oldest-first cursor, per-user cap.
- **[MEDIUM] Price-gate weak for a young pool.** `price-feed.ts:317-333` skips pre-first-candle buckets
  with no minimum candle count/pool age, so right after the $HIVRA launch a pumped spot passes the
  4-hour-median gate (deviates from `docs/token/HIVRA-ACTIVATION.md`). Affects deposit/yearly/managed-Venice
  quotes and tier "rate locks". VERIFIED PoC (1 candle → 5× accepted). Fix: require ≥N candles and a
  full-window pool age before any platform-token quote; exclude the in-progress bucket. *(The gate is
  otherwise SOUND for a mature $HermesOS pool — see Checked-clean.)*
- **[MEDIUM] `managed-venice-token-sweep` has no claim.** `managed-venice-token-sweep.ts:559-567` selects
  pending/failed with a whole-wallet balance check and no CAS (`:199,221,247`); a lost transfer response
  or overlapping run sends a second transfer of the same amount from the **shared** deposit wallet,
  taking other funds (e.g. an unswept yearly payment) into the treasury. VERIFIED harness. Fix: port the
  `credit-deposit-sweep` claim / in-doubt state machine.
- **[MEDIUM] `POST /api/ops/events` lets any signed-in user page the admin with attacker text.**
  `ops/events/route.ts:41-52` accepts `severity:"fatal"`; POST has no rate limit and no admin gate
  (`:157-199`); `lib/ops-events.ts:163-188` → `dispatchFatalAdminAlert` → Resend email (attacker title in
  subject) + Telegram. Also lets a caller set another user's `instanceId`/`failureOwner` → attacker banner
  in the victim's dashboard. VERIFIED. Fix: clamp non-admin severity to ≤`error`, verify `instanceId`
  ownership, strip `failureOwner`/`recoveryAction`, rate-limit.
- **[MEDIUM] `GET /api/health` makes an uncached Clerk + Stripe API call per request, unauthenticated,
  no rate limit** (`health/route.ts:33-66`, `lib/health/{clerk,stripe}.ts`). ~100 rps exhausts Stripe's
  live-key rate limit and Clerk quota → platform-wide checkout/auth failure. Fix: cache 30–60 s or gate
  deep checks behind `CRON_SECRET`.
- **[MEDIUM] `getIP()` trusts client `cf-connecting-ip` first** (`lib/rate-limit.ts:188-197`,
  `authenticated-rate-limit.ts:27-29`), so every IP-keyed (and the `route:userId:IP` "per-user") limit is
  bypassable by rotating the header, and a direct `*.vercel.app` request skips Cloudflare entirely.
  Amplifies transcription-key abuse, `reserve` enumeration, self-host login brute force. Fix: use the
  Vercel-set IP; trust `cf-connecting-ip` only behind a verified-Cloudflare flag; key authenticated
  limits on user id alone.
- **[MEDIUM] Prod only: 5 `SECURITY DEFINER` functions executable by `anon`/`authenticated`** —
  `record_cron_heartbeat(text)` (spoof cron health, table bloat), `refresh_credit_account_cached_balance(uuid)`
  (balance oracle if account UUID known), and 3 `enforce_*` trigger functions (not directly callable).
  Fixed on canary by migration `20260923001301_revoke_api_execute_on_definer_functions.sql`, **missing on
  prod.** Fix: apply that migration to prod (Needs Ash / promote runbook).
- **[MEDIUM] Apple IAP attach accepts revoked/refunded transactions and replayed JWS**
  (`mobile/iap/attach/route.ts:63-117` — no `revocationDate` check; `apple-webhook-service.ts:367-422`).
  The lane is **dormant** (no iOS client shipped). Fix before the iOS launch: reject `revocationDate`,
  confirm live status via `getAllSubscriptionStatuses`.
- **[MEDIUM] Wallet destination change has no step-up/cooldown/notice, and agent-wallet withdraws accept
  any recipient** (`billing/bankr/wallet/withdraw-address/route.ts:70-124`; `bankr-withdraw-route.ts:36-53`,
  `bankr-instance-withdraw.ts:643-733`; agent key `allowedRecipients:null`). Requires account takeover, but
  amplifies it to instant drain. Fix: step-up re-auth + 24–48 h delay + email on destination change;
  restrict token withdrawals to the saved destination.
- **[MEDIUM] Same-site CSRF on canary.** `canary.hermesos.cloud` is same-site with box hostnames
  `box-*.hermesos.cloud`; Clerk cookie is SameSite=Lax; ~55 cookie-authed mutation routes lack an Origin/
  Sec-Fetch-Site check and parse `req.json()` regardless of content-type; `proxy.ts` has no global check.
  Prod `hivra.cloud` is cross-site with boxes **today**, so this is canary-scoped **unless boxes move under
  `*.hivra.cloud`.** Fix: reject non-GET `/api/*` with `Sec-Fetch-Site` present and not `same-origin`
  (exempt webhooks/machine routes); longer term put boxes on a separate registrable domain.
- **[MEDIUM] Terminal attach proxy passes the box's Content-Type through to the dashboard origin**
  (`instances/[id]/terminal/interactive/route.ts:328-336`) → a compromised/prompt-injected box returns
  `text/html` and a chat link renders script on hivra.cloud. Fix: pin `text/event-stream` + nosniff, as the
  sibling SFTP route does.

---

## Low

- **[LOW] `/api/reserve` puts the submitted email into `ILIKE` unescaped** (`reserve/route.ts:17,105-133`;
  also `lib/reservations/promote-next.ts:266-313`). `%`/`_` give a 0/1/many oracle over waitlist emails and
  a signed-in user can bind a matched row to themselves. Fix: `.eq` on a normalized email / escape.
- **[LOW] `update-report` / `u/[id]` revives a `scheduled_for_deletion` instance to `running`**
  (`instances/[id]/update-report/route.ts:23-29,114-129`, aliased unauthenticated at `u/[id]`), taking it
  out of the purge cron's selection → VM kept forever at platform cost. Fix: add `scheduled_for_deletion`
  to `NON_RESURRECTABLE_STATUSES`.
- **[LOW] Link-only template forkable by its guessable slug without the share token**
  (`lib/hivra/agent-templates.ts:237-278` treats `link` like `public`; slugs have no random suffix). Leaks
  name/goal/personality/emoji/skill-ids only (`context` stripped, no secrets). Fix: serve `link` templates
  to non-owners only via `share_token`.
- **[LOW] `restore_backup` instance action trusts a caller-supplied Hetzner image id**
  (`instances/[id]/route.ts:2558,3150-3155`, no `bound_to === serverId` check). **Not exploitable today:**
  0 live instances on prod (of 154) or canary (of 3) carry `hetzner_server_id` directly or via an owned
  host. Latent — the UI has no caller. Fix: remove the action, or verify `type==='backup'` and `bound_to`.
- **[LOW] PATCH `backupsEnabled:true` enables paid Hetzner backups without the add-on charge**
  (`instances/[id]/route.ts:226,1970-1996`, host lookup not user-scoped). Hetzner-lane only (0 live). Fix:
  allow only `false`, or require the backup add-on entitlement; scope the host lookup by `user_id`.
- **[LOW] Canary `VERCEL_AUTOMATION_BYPASS_SECRET` is written into tenant-rooted guest VMs**
  (`hivra/agents/[id]/remote-desktop/route.ts:182,342-345`; `remote-computers/guest-installation.ts:222`;
  `provisioner/remote-desktop/install-guest.py:828` @ 0640 root:broker). A canary tenant with guest root
  reads the project-wide deployment-protection bypass. Canary-only (prod channel doesn't ship it). Fix:
  per-computer short-lived token; rotate the canary bypass secret.
- **[LOW] Legacy WebUI handoff puts the long-lived per-instance `apiServerKey` in the login URL query**
  (`lib/webui-handoff.ts:60,77-84,221-225`) → host-Caddy/Cloudflare access logs. Scoped to that one
  instance. Fix: short-lived sidecar-checked token. *(Already noted in `docs/PRODUCT-ARCHITECTURE.md:470`.)*
- **[LOW] CI secret scanning only checks the HEAD tree** (`.github/workflows/public-release-safety.yml`
  uses `gitleaks dir`, never `gitleaks git`), so a secret added and removed within a PR persists in
  `refs/pull/*`. Fix: add a range scan on `pull_request`; enable GitHub secret scanning + push protection.
- **[LOW] `.gitleaksignore` uses file:rule:line fingerprints (no value binding); 6 entries are stale, and
  default rules miss `bk_`/`hven_live_`/`hvra_otlp_` token formats.** Fix: add custom `[[rules]]` for those
  formats, allowlist fixtures by value/marker not path, and fail CI on stale ignore entries.

---

## Checked and found clean (high-value negatives)

- **Secrets in git history:** full-history scan (gitleaks 8.29.1 + custom regex) of a read-only mirror
  (620 commits, 14 branches, 111 PR refs; public history begins at a squashed import `250fd9d`) found
  **no live secret** — every hit is a fixture, placeholder, or public value (e.g. the well-known Anvil key,
  PostHog `phc_`, Qwen client id). No `.env`/`.pem`/`id_rsa`/`known_hosts` ever committed.
  *(Caveat: pre-import private history is not visible here — see Needs Ash on rotation.)*
- **`NEXT_PUBLIC_*` (59 names) and client bundles:** none holds a secret; `supabaseAdmin` is
  `typeof window==="undefined"`-guarded; no `'use client'` file imports server-secret modules; 203 modules
  use `import "server-only"`.
- **Supabase canary:** every public base table has RLS enabled; no `SECURITY DEFINER` function in
  public/private/api is executable by anon/authenticated; the only bucket is private; an anon-key-only
  attacker can do nothing useful via `/rest` or `/rpc`. Migrations after the PR #39/#40 cleanup all
  revoke EXECUTE from public/anon/authenticated and enable RLS on new tables (no regressions found).
- **Webhook signatures:** Stripe `constructEvent` on the raw body, fail-closed on missing secret, event-id
  dedupe (503 if the table is missing); Clerk svix HMAC with timing-safe compare + 5-min tolerance; Apple
  `SignedDataVerifier` with pinned roots, bundle-id/environment checks, `notificationUUID` dedupe.
- **Cron auth:** all 62 routes / 80 handlers fail closed (`bearer-auth.ts:17-51`: unset secret → reject,
  `timingSafeEqual`); a dynamic test of every handler (124/124) confirmed unset→500, spoofed
  `x-vercel-cron`/user-agent/`?secret` all rejected. `vercel.json` scheduled paths all exist.
- **Envelope crypto:** AES-256-GCM, random 12-byte IV per encryption, auth-tag verified, fails closed on a
  missing/short key; single legacy-key trial decrypt for rotation.
- **Minted Bankr key scopes** match the custody inventory (deposit sweeper allowlisted to treasury;
  single-use transfer key one-address; users can't influence recipients). **User-connected wallets cannot
  be withdrawn by Hivra** and the connect check rejects Hivra-created addresses (lowercased) and partner
  keys.
- **Instance/hivra/remote-desktop/workspace IDOR:** the shared owner-scoping helpers
  (`getSecureUserInstance`, `validateConsoleAccess`, `loadOwnedHermesInstance`, `loadOwnedHivraWalletAgent`,
  `do-managed-sessions.loadAgent`, the remote-desktop/workspace token SQL) enforce `user_id` before side
  effects across all routes reviewed; no route trusts a user id from the body/query/header. Remote-desktop
  and workspace session tokens are bound to computer+surface+audience with short TTLs and single-use
  exchange codes.
- **Crypto deposit crediting:** `crypto_deposit_receipts unique(chain_id,tx_hash,log_index)` +
  `unique(provider,reference_id)`; ledger `unique(source,reference_id,reason)` (23505 = no-op); CAS on the
  intent flip; token-address + exact-BigInt checks; deposit address server-set; sweep uses a CAS claim and
  exact amount. The internal settle route uses a dedicated `BILLING_SETTLEMENT_SECRET` (constant-time, no
  `CRON_SECRET` fallback).
- **Wallet verification:** 16-byte nonce bound to the user, 10-min expiry, viem `verifyMessage` (EOA only,
  no EIP-1271), one-account-per-address unique index + takeover revocation.
- **Dormant $HIVRA engine & geo gate:** activation only via hardcoded constants + service-role RPC
  (no env switch); `requirePlatformToken('hivra')` throws while dormant (routes 403); token-geo policy
  dormant. Confirmed it cannot be turned on by a user or missing env.
- **Guest-session tokens (hivra-chat):** per-box 64-hex API token, 32-byte session in an `__Host-` cookie
  (Secure/HttpOnly/SameSite=None/Partitioned), origin-checked mutations; box-wide + 12 h as documented; a
  token from box A cannot open box B.
- **Web:** react-markdown 10 with no `rehype-raw` (script/`javascript:`/`data:` payloads all neutralised);
  the bankr.bot convert allowlist (`lib/claim/conversion-state.ts:79-90`) rejected every bypass tried
  (`bankr.bot.evil.com`, `//evil.com`, `@evil.com`, homoglyph, `javascript:`…); `X-Frame-Options: SAMEORIGIN`
  and HSTS enforced; postMessage handlers all check origin+source.

---

## Needs Ash (decisions / prod / secrets — with steps)

1. **Apply the security-relevant migrations prod is missing, before/at Promote.** Prod
   (`prvdajgvxnkunvpmitbt`) is missing ~162–173 repo migrations by name, including
   `20260923001301_revoke_api_execute_on_definer_functions.sql` (closes the 5 anon-executable definer
   functions) and `20260922172439_enable_rls_remaining_public_tables.sql`. **Reconcile by name first**
   (many prod migrations were recorded under different version numbers, and prod has drift not in the repo),
   then apply. Full list: see the handoff doc. *(SELECT-only inspection done; no writes.)*
2. **Confirm/lock down Supabase auth on BOTH projects (decides the `hermes_instances` RLS finding).** In the
   Supabase dashboard, verify GoTrue **signup** and **anonymous sign-ins** are OFF and no Clerk third-party
   auth / JWT template is enabled. If any is on, the `authenticated`-role `ALL` policies become a
   cross-tenant server-deletion + self-escalation path. (Prod already shows 15 GoTrue users, 0 sessions —
   worth understanding why.)
3. **Confirm the managed-Venice upstream key type.** `VENICE_API_KEY` / `MANAGED_VENICE_INFERENCE_KEYS`
   must be **INFERENCE**, not ADMIN. If ADMIN, the `[...path]` passthrough lets any user mint Venice keys
   billed to Hivra (upgrade that finding to critical until the passthrough is allowlisted).
4. **Confirm prod Vercel env (I could not list env vars — the API token returned 403):**
   `CRON_SECRET` set and **distinct from canary**; `WORKSPACE_CLOUD_*_PRICE_ID` / `WORKSPACE_CLOUD_ALLOW_SHARED_PRICE`
   (gates the cross-lane finding); `APPLE_ACCEPT_SANDBOX_NOTIFICATIONS` unset; `GHCR_TOKEN` scope
   (`read:packages` only, or make images public); `MANAGED_VENICE_MULTIMODAL_BILLING_ENABLED`;
   `HERMES_MANAGED_VENICE_STARTER_CREDIT_ENABLED`.
5. **Secret rotation (owner action; do not rotate from a session):** because public git history starts at a
   squashed import, rotate any credential that ever sat in the retired private repos / old `.env` files if
   not already done. Rotate the canary `VERCEL_AUTOMATION_BYPASS_SECRET` after the guest-secret fix.
6. **Enable GitHub secret scanning + push protection** on `ashneil12/hivra`.
7. **ENCRYPTION_KEY rotation readiness:** workable (multi-key trial decrypt + CAS rewrap script covering the
   main columns) but **not proven safe to retire the old key** — ciphertexts carry no key-id/AAD, only one
   legacy slot, and `hivra_buzz_agent_bindings.encrypted_*` columns are neither rewrapped nor listed in the
   coverage gate (retiring the legacy key would brick Buzz identities). Set `LAUNCH_FINGERPRINT_KEY` and
   `CHAT_ENCRYPTION_KEY` separately before launch. Full steps in the handoff doc.

---

## Hardening ideas (not findings)

- Move the document CSP from report-only to an enforced nonce CSP; drop `unsafe-inline`/`unsafe-eval` and
  the jsDelivr `script-src`. Set Clerk `authorizedParties` and an explicit `allowedRedirectOrigins`.
- Add `import "server-only"` to `lib/supabase.ts`; drop the unused browser `supabase` export and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`; revoke default table grants from anon/authenticated and set
  `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM public, anon, authenticated`.
- Split `CRON_SECRET` into read-only feed / cron / admin tokens (it currently also authorises
  `admin/restore-batch`, `admin/warm-pool-campaign`, `ops/hivra/*`, and `ops/events/feed` invites sharing it
  with VM watchdogs).
- Revoke single-use Bankr transfer keys after use (the 20-key cap otherwise stalls sweeps after ~19
  top-ups); add TTLs to `in_flight` withdrawal claims; checksum + non-zero recipient validation.
- Use `redirect:"manual"` + re-validation in `ssrfSafeFetch`/`agent-gateway` (IP-literal redirects skip the
  DNS guard); widen `reservedIpv4Reason` ranges.
- Use a separate Hetzner Storage-Box-only SSH key on hosts (the fleet key is currently installed on every
  PVE host); keep host `rsync` patched (CVE-2024-12084…12088).
- Consider the `safe`/`finalized` block tag for irreversible credits (currently 3 confirmations on the
  unsafe head); ignore dust transfers before the claim lookup; add per-user caps.
- `agent-usage/ingest` lets an owner inflate public `/stats` (self-reported by design); `tier-check` and
  `reserve` are existence oracles; add per-user rate limits.
- Extend `command-output-redaction.ts` to match `bk_…`/`BANKR_*KEY=` (the `\b` boundary currently lets them
  through).

---

## Gaps / not covered

- **No live/end-to-end verification.** The container's egress policy blocks `*.hermesos.cloud`, so no finding
  was reproduced against the running canary; served-SHA was confirmed via the Vercel API, not HTTP.
- **Vercel env values not readable** (API token 403 on `filter_project_envs`) — every "gated on prod config"
  precondition is unverified from here (see Needs Ash 3–4).
- **Supabase auth settings** (GoTrue signup, anonymous, third-party) are dashboard-only and unverified
  (Needs Ash 2).
- **jsDelivr Content-Type/CSP headers, Cloudflare/Vercel WAF rules, and whether tenants get guest root** —
  unverified (no network probing). These decide the exact severity of the clerk-assets XSS, the health/rate-limit
  DoS, and the canary bypass-secret findings.
- Several reviewers stopped early (owner ended the session to save credits); per-area "NOT COVERED" lists are
  preserved in `/tmp/.../scratchpad/reports/` and the handoff doc. Notably not fully covered: deep
  managed-Venice token settlement saga, `token-access.ts` conversion/grace, several large route bodies past
  their ownership gates, the Hermes sidecar internals, and the encrypted-column ↔ rotation-coverage
  cross-check.
