# WebUI Iframe Migration Plan

**Status:** Proposed, not started.
**Author:** Claude (2026-05-09)
**Goal:** Replace the dashboard's broken middle-layer chat code (~60k LOC) with an iframe pointing at `ashneil12/hermes-webui` on each user's VM, with HMAC auth handoff and a "hermes-deploy" custom theme as default while keeping all 7 vanilla themes user-selectable.

---

## Status table (READ THIS FIRST)

| Check / Phase | Status | Notes |
|---|---|---|
| **Plan revision** | **v2 → v3 (2026-05-09)** | **Tightened Caddy/security details + stale v1 cleanup — see v2→v3 revision section** |
| **Plan revision** | **v1 → v2 (2026-05-09)** | **Auth handoff moved from webui to existing dashboard-sidecar — see v1→v2 revision section** |
| V1 (fork-vs-upstream gap is reproducible) | NOT RUN | Investigation said 7 ahead — verify before catchup |
| V2 (webui live state on a real VM) | NOT RUN | Confirm port 8787, bearer auth, FQDN routing |
| V3 (apiServerKey present in **dashboard-sidecar** env) [REVISED v2] | NOT RUN | HMAC verification is in sidecar, not webui — verify sidecar has it |
| V4 (current iframe headers / CSP posture) | NOT RUN | Capture before/after for rollback proof |
| V5 (deletion candidates are unreferenced outside chat) | NOT RUN | Grep imports of files marked for deletion |
| V6 (test:hot-paths chat coverage) | NOT RUN | Confirm which hot-path tests must be removed |
| V7 (sidecar nonce store handles two distinct flows) [NEW v2] | NOT RUN | Verify dashboard-login + webui-login don't collide on nonce tracking |
| V8 (sidecar restart recovery) [NEW v3] | NOT RUN | Sidecar sessions are in-memory; verify dashboard re-mints URL when iframe 401s after restart |
| Phase 0 (observability) | NOT STARTED | |
| Phase 1 (webui fork: theme + frame ONLY) [REVISED v2] | NOT STARTED | Blocked on V1. Auth-exchange endpoint REMOVED — sidecar handles handoff. |
| Phase 2 (dashboard: API route + client iframe shell + flag) [REVISED v2] | NOT STARTED | Independent of Phase 1. Server API route, not server component. |
| Phase 3 (Caddy + sidecar webui-login route + CSP frame-src) [REVISED v2] | NOT STARTED | Blocked on Phase 1. Bigger than v1: includes sidecar code. |
| Phase 4 (canary: 1 VM + 1 dashboard user) | NOT STARTED | Blocked on Phase 1, 2, 3 |
| Phase 5 (fleet rollout) | NOT STARTED | Blocked on Phase 4 stable for 48h |
| Phase 6 (delete dashboard chat code) | NOT STARTED | Blocked on Phase 5 stable for 7 days |

**Things needed from Ash to unblock execution:**
1. **Codex authority to merge upstream into ashneil12/hermes-webui** — small risk of conflict in `api/streaming.py`. Confirm Codex can land the merge or Ash reviews first.
2. **Approval to flip the dashboard feature flag** — Phase 4 canary and Phase 5 fleet flip are deploy-authority calls.
3. **Approval to delete dashboard chat code in Phase 6** — ~60k LOC delete. Reviewable as one PR but irreversible without git revert.
4. **One real instance to canary against** — Ash's own instance is the safest target.

---

## v2 → v3 update — Caddy/security tightening + stale v1 cleanup

**Reported by:** Codex pre-flight review (relayed by Ash), 2026-05-09 (second pass).
**Why this matters:** v2's auth architecture is correct, but several v1 leftovers remained in the prose, and a few Caddy/security details were too loose. Codex caught them all before execution.

| Plan said (v2) | Reality found / better practice | Fix |
|---|---|---|
| WebUI `frame-ancestors 'self' https://hermesos.cloud https://*.hermesos.cloud` | Wildcard would let ANY hermesos subdomain (including a hypothetical attacker-controlled per-VM URL) frame a customer's webui | Exact origins only: `https://hermesos.cloud https://dashboard.hermesos.cloud`. Dashboard `frame-src` can keep wildcard (outbound is less security-critical). |
| Caddy `forward_auth { copy_headers Cookie }` | `copy_headers` copies headers from auth RESPONSE back to the original request, not browser request → auth check. The cookie is already on the cloned request — no copy needed. Existing `@dashboard_browser` works without it. | Remove `copy_headers Cookie`. |
| Success criterion 7 said dashboard `frame-ancestors` allows per-VM origin | Backwards. Dashboard's `frame-ancestors 'self'` should stay. Per-VM origins go in dashboard `frame-src` (outbound). WebUI's `frame-ancestors` (inbound, who can frame webui) should be tight. | Rewrite criterion. |
| Release ordering said "Phase 1 auth-exchange endpoint must exist" | Auth-exchange endpoint was removed in v2. | Update to "Phase 1 webui frame patches + sidecar webui-login route must exist". |
| Phase 0 telemetry: webui `boot.js` emits `[hermes:auth-exchange]` logs | Auth is in sidecar now, not webui. Telemetry belongs in dashboard route + sidecar console logs. | Move telemetry hook. |
| Handoff note 9 mentions upstreaming auth-exchange endpoint | Endpoint no longer exists. | Replace with: upstream the X-Frame-Options config patch only. |
| Handoff note 2 says "Run pre-flight V1-V6 in order" | V7 was added in v2; V8 added in v3. | Update to V1-V8. |
| `WEBUI_HANDOFF_TTL_MS = 5 * 60 * 1000` (5 min) in helper | Existing `OFFICIAL_DASHBOARD_LOGIN_TTL_MS = 30_000` (30s) sets the precedent. Sidecar accepts up to `DASHBOARD_LOGIN_TTL_MS = 60_000`. Shorter is cleaner — reduce attack window. | `WEBUI_HANDOFF_TTL_MS = 30_000` to match dashboard precedent. Sidecar tolerance can stay 60s. |
| Phase 3 said "sidecar image rebuild" | Sidecar runs `node:22-alpine` with `sidecar_server.js` mounted from a generated artifact. No image rebuild — regenerate the artifact, fleet-live-update writes it, container restarts. | Update Phase 3 deploy wording. |
| iframe `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"` | Missing `allow-downloads`. WebUI exposes file downloads (chat artifacts, exported sessions). | Add `allow-downloads`. |

### NEW V8: sidecar restart recovery test [NEW v3]

Sidecar's `webuiSessions` map is in-memory. If `dashboard-sidecar` container restarts, browsers still hold valid `hermes_webui_session` cookies but sidecar has forgotten them — every iframe request gets 401 from `/webui-session-check`. Dashboard must detect this and re-mint a login URL automatically. See V8 in the pre-flight section.

### Net effect on phases

- Phase 1: unchanged.
- Phase 2: TTL change (5min → 30s) in `signWebuiHandoffUrl()`. Iframe sandbox includes `allow-downloads`. Client component handles "iframe load returned 401" by re-fetching the login URL.
- Phase 3: exact `frame-ancestors` origins. No `copy_headers Cookie`. Deploy wording corrected (sidecar artifact regen, not image rebuild).
- Phase 0: telemetry moves to dashboard route (already there) + sidecar console logs (existing pattern). No webui `boot.js` instrumentation.
- Pre-flight: V8 added.
- Handoff notes 2 and 9 corrected.
- Success criterion 7 corrected.

### No new user blockers (v3)

All v3 fixes are inline plan edits. No new SSH, no new approvals.

---

## v1 → v2 update — Auth handoff moves to existing dashboard-sidecar (not webui Python)

**Reported by:** Codex pre-flight review (relayed by Ash), 2026-05-09.
**Why this matters:** v1 put the HMAC verification inside webui Python. That doesn't work because Caddy gates everything BEFORE webui — a `hermes_session` cookie that webui mints would still be rejected by Caddy. Plus webui's container env doesn't have `API_SERVER_KEY`. The fix is to mirror the existing official-dashboard handoff pattern, which already works the way we need. Codex caught this before any code was written — the plan-revision-on-pre-flight-failure protocol working as designed.

| Plan said (v1) | Reality found | Citation |
|---|---|---|
| WebUI Python validates HMAC at `/api/auth/exchange` and mints session cookie | Caddy gates **before** webui. WebUI cookies aren't visible to Caddy unless we teach Caddy to verify them. The cookie auth path is meant for sidecar-routed traffic. | [webui-instance-builder.ts:805-886](Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:805) — `@dashboard_browser` matcher routes to dashboard-sidecar, not webui |
| `API_SERVER_KEY` is in webui's container env | `buildWebUIComposeEnv()` explicitly does NOT set it. Comment: "Intentionally NOT setting HERMES_WEBUI_PASSWORD: auth is enforced at Caddy now". The key lives in agent env (`buildHermesEnvFile()`) and sidecar env, not webui. | [webui-instance-builder.ts:916-947](Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:916), [webui-instance-builder.ts:953](Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:953), [sidecar-script.ts:168](Hermesdeploy/dashboard/src/lib/services/sidecar-script.ts:168) |
| Page-side server component mints iframe token inline in `page.tsx` | `page.tsx` is a client component (`'use client'` line 1). Cannot do server-side signing in the same file. | [page.tsx:1](Hermesdeploy/dashboard/src/app/dashboard/instances/[id]/page.tsx:1) |
| Update CSP `frame-ancestors` allowlist on the dashboard | Wrong direction. `frame-ancestors` controls who can frame YOU. Dashboard's own `frame-ancestors 'self'` should stay. We need: (a) dashboard `frame-src` allowing per-VM webui, (b) webui's response `frame-ancestors` allowing dashboard origin (set in Caddyfile, not in webui). | [next.config.ts:92](Hermesdeploy/dashboard/next.config.ts:92) — `frame-src 'self' https://js.stripe.com ...` lacks hermesos.cloud subdomains |

### New auth flow (v2)

```
1. Browser loads dashboard instance page (client component).
2. Page calls API route: GET /api/instances/[id]/webui-login-url
3. Server route signs HMAC: https://<fqdn>/_sidecar/webui-login?exp=...&nonce=...&sig=...
4. Page sets <iframe src=...> with that URL.
5. Iframe navigates → Caddy routes /_sidecar/* to dashboard-sidecar:9090.
6. Sidecar's NEW handleWebuiLogin(): verifies HMAC, sets cookie
   `hermes_webui_session=<id>; SameSite=None; Secure; HttpOnly`,
   redirects to / (or the iframe target path).
7. Browser request (now with cookie) → Caddy's NEW @webui_browser matcher.
8. Caddy: forward_auth → sidecar /webui-session-check → reverse_proxy webui:8787.
9. WebUI receives request as anonymous; Caddy already gated it via cookie validation.
```

The pattern mirrors the existing `handleDashboardLogin` at [sidecar-script.ts:434](Hermesdeploy/dashboard/src/lib/services/sidecar-script.ts:434). WebUI fork doesn't need to know about any of this.

### Net effect on phases

- **Phase 1 (webui fork)** — SHRINKS to ~50% of v1. Only theme additions + X-Frame-Options config patch. No `api/auth.py` changes, no new route, no SameSite cookie changes, no `API_SERVER_KEY` distribution. Marked `[REVISED v2]` below.
- **Phase 2 (dashboard)** — RESHAPES. Now: server API route (`/api/instances/[id]/webui-login-url`) returns signed URL; client component fetches on mount and sets iframe `src`. Helper `src/lib/webui-handoff.ts` still exists. Marked `[REVISED v2]` below.
- **Phase 3 (was "Caddy CSP fleet update")** — EXPANDS. Now includes sidecar code changes (new `handleWebuiLogin` + `/webui-session-check` + `usedWebuiNonces` map), Caddyfile additions (`@webui_browser` matcher + handle block), webui-block response header (`frame-ancestors`), and dashboard CSP `frame-src` update (NOT `frame-ancestors`). Marked `[REVISED v2]` below.
- **Pre-flight V3** — REPLACED. Was "verify `API_SERVER_KEY` in webui container". Now "verify `API_SERVER_KEY` in **dashboard-sidecar** container" (which it should be — sidecar already verifies official-dashboard handoffs with it).
- **NEW V7** — verify the sidecar's existing `usedDashboardNonces` map and the new `usedWebuiNonces` map don't collide / share state in a problematic way. They should be separate maps; quick code review.

### New user blockers (v2)

- Confirm Codex can edit dashboard-sidecar (`src/lib/services/sidecar-script.ts`) — sidecar code runs INSIDE the per-instance container, deploys via the existing image rebuild + fleet-live-update path. Same authority as agent code.
- No new external dependencies. No JWT lib needed. No new env-var distribution.

---

## Why this plan exists

The dashboard's chat surface has been wedge-prone for months. Symptoms quoted by Ash: "chat is just like not completely reliable, everything is just bit funny," "backend is just broken left, right, center." Past fixes have been symptom-level patches (overlay decoration, chat-stream-events error decode, conversation overlay fail-open, postgres error code surfacing) — none address the structural problem.

**Structural cause:** the dashboard runs its own conversation persistence, SSE proxying, error decoding, and message ID synthesis on top of `webui` running on each user's VM. The two sides have drifted on session model, error envelopes, and stream lifecycle. Every wedge is a translation bug between layers.

**This plan removes the middle layer entirely.** The dashboard becomes a pure platform shell (auth/billing/provisioning). The agent UX moves to webui, exposed via iframe. Webui's mature chat (3,658 tests, IME/PWA/offline/multi-locale polish) becomes the user experience directly.

The decision to use webui (not workspace) was made after capability comparison: webui has the polish and test investment for a reliable chat experience; workspace's swarm/conductor features are deferred as a Phase-2 portable port.

---

## Root cause synthesis

| Symptom user saw | Real cause |
|---|---|
| "Copy report" failures, undecodable errors | Dashboard's `chat-send-stream-events.ts` decodes a contract that drifts from webui's actual error events ([src/lib/chat-send-stream-events.ts](src/lib/chat-send-stream-events.ts)) |
| Conversation overlay 409s and PostgREST errors | Dashboard maintains a `hermes_conversations` overlay table separate from webui's session DB ([src/lib/webui/](src/lib/webui/)) |
| SSE late-attach drains, heartbeat stalls | Two-stream architecture: dashboard re-streams webui's SSE through its own route handler; cleanup race is in the proxy layer (recent ash-fork fix `a063230`) |
| "Generate title" route broken on certain conversations | Title generation uses dashboard-side conversation IDs that don't always map to webui session keys (`api/conversations/[conversationId]/generate-title/route.ts`) |
| Chat just feels "funny" / unreliable | Net of dozens of small translation bugs, each individually patchable but structurally inevitable |

Cite for executor: [Hermesdeploy/dashboard/src/lib/webui/](Hermesdeploy/dashboard/src/lib/webui/), [Hermesdeploy/dashboard/src/lib/chat-send-stream-events.ts](Hermesdeploy/dashboard/src/lib/chat-send-stream-events.ts), [Hermesdeploy/dashboard/src/app/api/conversations/](Hermesdeploy/dashboard/src/app/api/conversations/).

---

## Goal & target architecture

The dashboard becomes a platform shell only. WebUI runs on each user's VM, is exposed via an iframe inside the dashboard at the per-instance page, and authenticates the iframe via a short-lived HMAC token signed with the per-instance `apiServerKey` (which both sides already have).

```
TODAY (broken):
[Browser]
   ↓ HTTPS
[Dashboard @ hermesos.cloud]
   ↓ /api/instances/[id]/send-stream  ← BROKEN MIDDLE LAYER (~60k LOC)
   ↓ HTTPS + Bearer
[Caddy on user VM @ <fqdn>]
   ↓ proxy to :8787
[hermes-webui Python @ :8787]
   ↓ in-process AIAgent
[Hermes Agent — state.db]

AFTER (v2 — sidecar handles handoff, not webui):
[Browser]
   ↓ HTTPS, fetches /api/instances/[id]/webui-login-url
[Dashboard @ hermesos.cloud]                  ← platform shell only
   ↓ returns https://<fqdn>/_sidecar/webui-login?exp=...&nonce=...&sig=...
[Browser sets iframe src to that URL, navigates iframe]
   ↓
[Caddy on user VM @ <fqdn>]
   ├─ /_sidecar/* → dashboard-sidecar:9090
   │     └─ handleWebuiLogin(): verify HMAC, mint hermes_webui_session cookie, 302 → /
   ├─ @webui_browser (Cookie: hermes_webui_session) → forward_auth sidecar /webui-session-check
   │     └─ on valid: reverse_proxy webui:8787
   ├─ @authBearer (existing path, unchanged) → reverse_proxy webui:8787
   └─ @public (existing) → reverse_proxy webui:8787
[hermes-webui Python @ :8787]                 ← anonymous; Caddy already gated it
   ↓ in-process AIAgent
[Hermes Agent — state.db]
```

**Key principle:** the dashboard does not see chat traffic. The iframe and the agent talk directly. WebUI is unchanged at the auth layer — sidecar handles all browser-cookie auth before requests reach webui.

---

## Success criteria (definition of done)

A change is only "done" when ALL of these hold on a fresh test target:

1. New user signs up → provisions instance → lands on instance page → iframe loads webui → user is authenticated without seeing webui's login screen (auth handoff works end-to-end).
2. Sending a chat message in the iframe streams a response with no dashboard middle-layer involvement (verified by absence of dashboard `/api/instances/[id]/send-stream` requests in network tab).
3. The "hermes-deploy" theme is the default; user can switch to any of the 7 vanilla themes via Settings → Theme; choice persists across page reloads.
4. WebUI iframe survives dashboard navigation (back/forward) without losing session state.
5. Auth handoff token rejects expired tokens (>5 min old) and tampered signatures (verified by red-team test in pre-flight).
6. Cookie scope: webui session cookie does not leak to dashboard origin; dashboard Supabase cookie does not leak to webui origin.
7. **Dashboard CSP `frame-src`** lists per-VM webui origins (outbound: dashboard frames webui). **WebUI's response `frame-ancestors`** lists exact dashboard origins only — `https://hermesos.cloud https://dashboard.hermesos.cloud` (inbound: who can frame webui — must be tight, no wildcards). Dashboard's own `frame-ancestors 'self'` stays unchanged. [REVISED v3]
8. After Phase 6 deletion, `pnpm test` and `pnpm test:hot-paths` pass on the dashboard with the conversation/chat-stream tests removed.
9. Fleet update applies cleanly via existing `ops:webui:fleet-live-update` — zero VMs left in a broken state.
10. Sentry/observability shows iframe load success rate >99%, auth-exchange success rate >99% (after canary stabilizes).

---

## Pre-flight verification (DO FIRST — ~3h)

These answer questions the plan depends on. **The executor must STOP on any failure and report — not improvise. Not patch the plan silently. Not "try the next thing."**

### V1 — Reproduce the fork-vs-upstream gap

**Category:** code-assumption
**Why:** Investigation reported 7 commits ahead of upstream master, but earlier conversation claimed 671 behind. The numbers don't reconcile. We must know the real state before merging.

**Steps:**
1. `cd /Users/example/Projects/hermes-webui && git fetch origin --quiet`
2. `git log origin/master..ash/master --oneline | wc -l` — commits in fork-master not upstream (expect 7, was 25)
3. `git log ash/master..origin/master --oneline | wc -l` — commits in upstream not in fork-master (expect 0 if recently merged, or N if stale)
4. `git log origin/master..ash/master --oneline` — list the actual ash-fork commits

**Pass:** Both `wc -l` queries return matching numbers to investigation report (7 ahead, 0 behind on master). Or: an explainable delta (e.g., new upstream commits since investigation).
**Fail handling:**
- If "ahead count" >> 7: STOP. The fork has accumulated more customization than expected. Audit what each new commit does before merging upstream.
- If "behind count" >> 0 and large: STOP. There's a new upstream batch since investigation. Re-run investigation step 3 (likely-conflict-zone analysis) before merging.

### V2 — WebUI live state on a real VM

**Category:** live-state
**Why:** All assumptions about per-VM URLs, ports, bearer auth, and CSP posture come from code reading. Must verify a real running instance matches.

**Steps (Ash runs — Codex cannot SSH):**
1. SSH into one production VM (any active user's instance, e.g. Ash's own).
2. `docker ps` — confirm webui, gateway, sidecar, official-dashboard, dashboard-sidecar containers are running.
3. `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8787/health` from inside the VM. Expect 200.
4. `curl -s -o /dev/null -w "%{http_code}\n" https://<fqdn>/health` from outside. Expect 200.
5. `curl -s -o /dev/null -w "%{http_code}\n" https://<fqdn>/api/sessions` (no auth header). Expect 401.
6. `curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <api_server_key>" https://<fqdn>/api/sessions`. Expect 200.
7. `curl -sI https://<fqdn>/` and capture the response headers. Look for X-Frame-Options, Content-Security-Policy.

**Pass:**
- /health public from outside (200)
- /api/sessions requires bearer (401 → 200 with header)
- No X-Frame-Options or CSP frame-ancestors header on webui responses (matches investigation)

**Fail handling:**
- If headers ARE set: STOP. Caddy posture is different than investigation reported. Check `buildWebUICaddyfile()` output on this VM with `cat /opt/hermes/instances/<id>/Caddyfile`.
- If port 8787 is wrong: STOP. The internal port may have been changed; update plan and constants.

### V3 — apiServerKey availability in dashboard-sidecar (NOT webui) [REVISED v2]

**Category:** live-state
**Why:** v2 puts the HMAC verification in **dashboard-sidecar**, which already validates the official-dashboard handoff. The same `API_SERVER_KEY` is reused for the new webui-login endpoint. Verify it's present in the sidecar container (it should be — sidecar already verifies official-dashboard handoffs with it).

**Steps:**
1. From the dashboard repo: pick one instance's `id` from supabase. Run a one-off script that reads `api_server_key_encrypted` and decrypts it (existing code path in `src/lib/services/hetzner-instance-service.ts`).
2. SSH into that VM. `docker exec <containerName>-dashboard-sidecar printenv API_SERVER_KEY`. Expect the same value.
3. Negative confirmation: `docker exec <webui-container> printenv API_SERVER_KEY` — expect EMPTY (per `buildWebUIComposeEnv()` comment, this is intentional).
4. `docker exec <containerName>-dashboard-sidecar printenv | grep -i hermes` — verify INSTANCE_ID and other expected vars.

**Pass:**
- Sidecar has `API_SERVER_KEY` matching DB-decrypted value byte-for-byte.
- WebUI's `API_SERVER_KEY` is unset (correct — auth is at Caddy layer).

**Fail handling:**
- If sidecar key missing: STOP. The official-dashboard handoff shouldn't be working today either. Investigate before any plan changes.
- If sidecar key mismatches DB: STOP. Provisioning drift. Reconcile before proceeding.
- If webui DOES have the key (unexpected): not a blocker, but flag — means the v1 plan would have worked too. Continue with v2 since it's still cleaner architecturally.

### V4 — Capture current iframe-rejection state for rollback proof

**Category:** live-state
**Why:** Need a before/after artifact. If we accidentally regress framing posture, want to detect it.

**Steps:**
1. Build a 5-line HTML page locally with `<iframe src="https://<fqdn>/"></iframe>`.
2. Open it in Chrome. Open DevTools → Console.
3. Capture the exact error message (likely "Refused to display in a frame because it set 'X-Frame-Options' to 'sameorigin'" OR no error if webui has no header).
4. Save the screenshot + HAR file to `_plan-artifacts/v4-before.har` in the worktree.

**Pass:** Captured artifact exists.
**Fail handling:**
- If iframe LOADS today (no error): great — webui's Caddy already permits framing, Phase 3 may be a no-op. Note this and continue.

### V5 — Confirm deletion candidates are not referenced outside chat

**Category:** code-assumption
**Why:** Investigation listed ~60k LOC for deletion. Some files might be imported by non-chat code paths (e.g. an admin panel that uses `chat-content.ts` for marketing copy rendering).

**Steps:**
1. For each file/directory marked for deletion (see Phase 6 file list), `grep -r "from '<file>'" /Users/example/Projects/Hermesdeploy/dashboard/src --include='*.ts' --include='*.tsx'` — check imports outside chat-related code.
2. Build a "safe to delete" list and a "needs careful unwiring" list.
3. Specifically verify: `chat-content.ts`, `chat-telemetry.ts`, `chat-usage.ts` — these have generic-sounding names that might be reused.

**Pass:** All deletion candidates are imported only by other deletion candidates or by files in the "modify" list.
**Fail handling:**
- If a deletion candidate is imported by a non-chat surface (marketing, admin, billing): STOP. Move it to the "modify" list. Either extract the non-chat helper or replicate it in a non-chat module.

### V6 — `test:hot-paths` chat test inventory

**Category:** code-assumption
**Why:** `test:hot-paths` runs on every PR. Removing chat code breaks any test in this list that imports the removed code. We need to know which tests must be removed from `package.json`.

**Steps:**
1. Read [package.json:49](Hermesdeploy/dashboard/package.json:49) (`test:hot-paths` definition).
2. Cross-reference each listed test path with the deletion list.
3. For each match, confirm the test is purely about chat (not an integration test that touches chat plus other surfaces).

**Pass:** Have a definitive list of tests to remove from `test:hot-paths` (4 tests per investigation: `chat-stream.test.ts`, `chat-stream-fallback.test.ts`, `generate-title.route.test.ts`, conversations `route.test.ts`).
**Fail handling:**
- If any removed-test covers non-chat behavior too: STOP. The test must be rewritten to keep its non-chat coverage, then the chat assertions removed.

### V7 — Sidecar nonce/session stores accept two distinct flows [NEW v2]

**Category:** code-assumption
**Why:** v2 adds `handleWebuiLogin` alongside the existing `handleDashboardLogin`. They must use SEPARATE nonce-tracking maps and SEPARATE session-id maps so that consuming a webui-login nonce doesn't accidentally consume an official-dashboard nonce (or vice versa). Cookie names must also be distinct (`hermes_webui_session` vs `hermes_dashboard_session`).

**Steps:**
1. Read [sidecar-script.ts](Hermesdeploy/dashboard/src/lib/services/sidecar-script.ts) — find `usedDashboardNonces`, `dashboardSessions`, `pruneDashboardState`, cookie name in `buildDashboardCookie`.
2. Confirm we will introduce separate `usedWebuiNonces`, `webuiSessions`, `pruneWebuiState`, `buildWebuiCookie` (no shared state).
3. Check if there's any global `pruneAllState()` or session-counting that would need to know about both.

**Pass:** Stores are independent in v1 of the codebase. Adding parallel maps for webui is straightforward.
**Fail handling:**
- If sidecar has shared state (single nonce store across all flows): STOP. Decide whether to refactor to per-flow maps OR namespace nonces (e.g. prefix with `dashboard:`/`webui:`). Ask Ash before choosing.
- If session expiry/pruning is global: ensure new webui sessions are pruned too.

### V8 — Sidecar restart recovery [NEW v3]

**Category:** live-state (canary-time check)
**Why:** Sidecar's `webuiSessions` Map lives in process memory. If the container restarts (deploy, OOM, crash), browsers still hold valid `hermes_webui_session` cookies but sidecar has forgotten them. Every subsequent iframe request gets 401 from `/webui-session-check`, so the iframe loads white. The dashboard's client component must detect this and silently re-fetch the login URL + reload the iframe.

**Steps (Ash runs on canary VM, Phase 4):**
1. Open dashboard with iframe loaded; verify chat works.
2. SSH into VM: `docker restart <containerName>-dashboard-sidecar`.
3. Wait 5 seconds for sidecar to be healthy (`docker exec <containerName>-dashboard-sidecar curl -sf http://127.0.0.1:9090/dashboard-logout`).
4. Reload the iframe in the browser (or trigger a chat send).
5. **Expected:** dashboard's client component detects 401, fetches new login URL, iframe reloads cleanly within ~2 seconds. User barely notices.
6. **Failure:** iframe shows raw 401 / blank, user must hard-refresh dashboard.

**Pass:** iframe recovers without user-visible breakage.
**Fail handling:**
- If iframe doesn't auto-recover: client component needs better error handling. Add a `WebuiIframe` `onError` → re-fetch URL + reset src. Land before Phase 5 fleet rollout.

---

## Architecture target state (re-stated for clarity) [REVISED v2]

- **Read path (token mint):** Browser at `/dashboard/instances/[id]` → client component fetches `GET /api/instances/[id]/webui-login-url` → dashboard server route reads `apiServerKey` (existing decryption path), signs `<exp>.<nonce>.<sig>` via `signWebuiHandoffUrl()` (mirrors `signOfficialDashboardHandoff`), returns `{ url: "https://<fqdn>/_sidecar/webui-login?exp=...&nonce=...&sig=..." }`.
- **Iframe load:** Client sets `<iframe src={url}>`. Browser GETs the URL → Caddy `/_sidecar/*` route → reverse_proxy to `dashboard-sidecar:9090`.
- **Write path (sidecar verification):** Sidecar's new `handleWebuiLogin()`:
  - Validates `exp`, `nonce` format, `sig` (HMAC-SHA256 with `API_SERVER_KEY`).
  - Rejects replay via `usedWebuiNonces` map (separate from `usedDashboardNonces`).
  - Calls new `createWebuiSession()` → sets cookie `Set-Cookie: hermes_webui_session=<id>; SameSite=None; Secure; HttpOnly; Path=/`.
  - 302 redirect to `/` (or query-param `next` path).
- **Subsequent requests:** Browser sends cookie. Caddy's new `@webui_browser` matcher (cookie present) does `forward_auth dashboard-sidecar:9090 /webui-session-check`. On 200 from sidecar, `reverse_proxy webui:8787`. On 401, browser is redirected back to login URL.
- **Stream path:** All streaming happens between iframe and webui:8787. Dashboard never proxies. Sidecar only validates the cookie on each request.
- **Cache:** Per-cookie session record in sidecar memory. Persists for sidecar process lifetime (matches existing `dashboardSessions` semantics).

---

## Release, migration & blast radius

- **Deploy target:** Three surfaces — (a) dashboard (Vercel), (b) webui fork image (`ghcr.io/ashneil12/hermes-webui:stable`), (c) per-instance Caddy config (via existing fleet-update tooling).
- **Deploy trigger:**
  - Dashboard: Git push → Vercel auto-deploy.
  - WebUI image: Git push to `main` of `ashneil12/hermes-webui` → CI builds `:stable` (existing workflow per ash-fork commit `7aee310`).
  - Per-instance Caddy: `pnpm ops:webui:fleet-live-update` (existing script).
- **Migration behavior:** No DB migrations. Existing webui sessions/conversations continue to work. Dashboard's `hermes_conversations` overlay table is left in place during canary; deletion is Phase 6 cleanup only after stable.
- **Old-code-vs-new-migration safety:** N/A — the migration is code-only. Dashboard old code keeps working until iframe page rolls out behind feature flag.
- **Ordering constraints (HARD) [REVISED v3]:**
  - Phase 1 (webui fork: theme + frame patches) MUST ship before Phase 4 (canary). WebUI must have `HERMES_WEBUI_FRAME_POLICY=ALLOWALL` honored before iframing.
  - Phase 3 (sidecar webui-login route + Caddy `@webui_browser` matcher + CSP headers) MUST apply to a VM before that VM is canaried. The sidecar code is what verifies the HMAC handoff — without it, the iframe loads webui-login, sidecar 404s, browser shows broken iframe.
  - Phase 6 (deletion) MUST come last. Even after Phase 5 fleet-rollout, keep the dashboard chat code for at least 7 days as the rollback path.
- **Rollback path:**
  - Layer (a) dashboard: feature flag flip → instant revert to legacy chat surface.
  - Layer (b) webui image: redeploy previous `:stable` digest. (Existing `fleet-pull-stable-image.ts` accepts a digest pin.)
  - Layer (c) Caddy: redeploy previous Caddyfile via `fleet-apply-live-update`.
- **Blast radius:**
  - Phase 4 canary: 1 user (Ash). Failure surface = Ash's instance.
  - Phase 5 fleet rollout: All paying users. Mitigation = feature flag flip on dashboard side rolls back all of them at once.
  - Phase 6 deletion: irreversible without git revert. Hold for 7 days post Phase 5 to ensure stability.

---

## Phased execution

### Phase 0 — Observability foundation (~3h)

**Don't skip this. It's the safety net for everything that follows.**

**Goal:** Add Sentry breadcrumbs and analytics events for iframe load, auth-exchange success/fail, and dashboard fallback triggers, so Phase 4 canary can be evaluated quantitatively.

**Files to add/modify [REVISED v3]:**
- [Hermesdeploy/dashboard/src/lib/telemetry/iframe-events.ts](Hermesdeploy/dashboard/src/lib/telemetry/iframe-events.ts) — new helper, exports `trackIframeLoaded`, `trackIframeError`, `trackHandoffUrlMint` (dashboard side only).
- [Hermesdeploy/dashboard/src/components/webui/WebuiIframe.tsx](Hermesdeploy/dashboard/src/components/webui/WebuiIframe.tsx) — wire iframe `onLoad`/`onError` + handoff-URL-fetch outcomes to telemetry.
- [Hermesdeploy/dashboard/src/app/api/instances/[id]/webui-login-url/route.ts](Hermesdeploy/dashboard/src/app/api/instances/[id]/webui-login-url/route.ts) — log mint outcome via existing dashboard logger so Sentry breadcrumbs capture it.
- Sidecar `sidecar-script.ts` `handleWebuiLogin` + `handleWebuiSessionCheck` — emit `console.info('[sidecar:webui-login]', { ok, reason })` for failures (matches existing `handleDashboardLogin` log style). These show up in container logs, ingestible by existing log pipeline.
- **No webui-side instrumentation** (was in v1 plan, removed in v3 — auth is in sidecar now, webui doesn't see the handoff).

**Verification gate before merging:**
- Open dashboard locally, load instance page, verify telemetry events fire in DevTools console.
- Sentry dashboard shows the new event names within 10 minutes of a test page load.

**Rollback:** Revert the file. Telemetry is purely additive.

**Risk to watch:** Sentry rate-limiting under fleet rollout — verify event volume estimate before Phase 5.

---

### Phase 1 — WebUI fork: theme + frame header patches ONLY (1.5 days) [REVISED v2]

**HARD PRECONDITION:** V1 passed.
**Removed in v2:** auth.py changes, routes.py auth-exchange endpoint, cookie SameSite changes. All auth handoff logic moved to dashboard-sidecar in Phase 3.

**Goal:** Surgical patches on `ashneil12/hermes-webui` that enable iframe embedding (X-Frame config) and add the "hermes-deploy" theme as default. **No auth changes.**

**Files to modify (in `/Users/example/Projects/hermes-webui`):**

1. **Catch up to upstream first.**
   - `git fetch origin && git checkout ash/master && git merge origin/master`
   - Resolve any conflicts (per investigation, likely in `api/streaming.py` and `api/routes.py`).
   - Run `pytest tests/ -x` and ensure existing 3,658 tests pass.

2. **`api/helpers.py:41`** — make X-Frame policy configurable.
   ```python
   # Before:
   handler.send_header('X-Frame-Options', 'DENY')
   # After:
   frame_policy = os.getenv('HERMES_WEBUI_FRAME_POLICY', 'DENY').upper()
   if frame_policy == 'DENY':
       handler.send_header('X-Frame-Options', 'DENY')
   elif frame_policy == 'SAMEORIGIN':
       handler.send_header('X-Frame-Options', 'SAMEORIGIN')
   # 'ALLOWALL' or anything else: emit no header
   ```
   Add a test in `tests/test_frame_policy.py` covering the three cases. Submit as PR upstream — high chance nesquena merges, then this fork patch goes away.

3. **Theme: add hermes-deploy as default.**
   - **`static/style.css`** — add `:root.hermes-deploy { ... }` block with the 27 variables. Use HermesOS dashboard tokens from investigation:
     ```css
     :root.hermes-deploy {
       --bg:#080810; --sidebar:#0a0a12; --border:rgba(212,175,55,0.18);
       --border2:rgba(212,175,55,0.24); --text:#f4eee5; --muted:#bfb7aa;
       --accent:#d4af37; --blue:#7dd3fc; --gold:#d4af37; --code-bg:#080810;
       --surface:#0a0a12; --topbar-bg:rgba(10,10,18,0.98); --main-bg:rgba(8,8,16,0.5);
       --input-bg:rgba(212,175,55,0.08); --hover-bg:rgba(212,175,55,0.12);
       --focus-ring:rgba(212,175,55,0.35); --focus-glow:rgba(212,175,55,0.10);
       --strong:#fff; --em:#d0ceff; --code-text:#d0ceff;
       --code-inline-bg:rgba(0,0,0,0.35); --pre-text:#f4eee5;
       --accent-hover:#FFBF00; --accent-bg:rgba(212,175,55,0.08);
       --accent-bg-strong:rgba(212,175,55,0.15); --accent-text:#d4af37;
       --error:#f87171; --success:#60d394; --warning:#fbbf24; --info:#7dd3fc;
     }
     ```
   - **`static/index.html:683-702`** — add a button `<button data-theme-val="hermes-deploy" onclick="_pickTheme('hermes-deploy')">HermesOS</button>` to the theme picker grid.
   - **`static/index.html:702`** — change hidden input default `value="dark"` → `value="hermes-deploy"`.
   - **`static/boot.js:118`** — change fallback `|| 'dark'` → `|| 'hermes-deploy'`.
   - **`static/panels.js:2804`** — change fallback `|| 'dark'` → `|| 'hermes-deploy'`.
   - **`static/commands.js:489`** — add `'hermes-deploy'` to the `themes` array so `/theme hermes-deploy` works.
   - Test: visual smoke locally + `tests/test_theme_inventory.py` checking the 27 CSS vars are all defined for the new theme block.

**Verification gate:**
- All existing tests pass: `pytest tests/`. New test file `tests/test_frame_policy.py` added.
- Local: run webui with `HERMES_WEBUI_FRAME_POLICY=ALLOWALL`, embed in a local iframe page, observe no X-Frame block. With `=DENY`, observe block.
- Theme: `/theme hermes-deploy` switches correctly; reload preserves the theme; settings panel button appears with HermesOS label.
- Default theme on a fresh profile (no localStorage) lands on `hermes-deploy`.

**Rollback:** Revert the merge commit on `ash/master`. CI will republish prior `:stable` digest.

**Risk to watch:** Upstream may have heavy churn in `static/style.css`, `static/index.html`, or `static/boot.js` (per investigation, these saw 290/106/227 line changes recently). Theme block additions may collide with upstream's CSS edits. Resolve by re-applying our theme block at the bottom of the upstream version of `style.css`.

---

### Phase 2 — Dashboard: server API route + client iframe shell + feature flag (3 days) [REVISED v2]

**Independent of Phase 1.** Can develop in parallel. Feature flag keeps it dark until Phase 4.
**Reshape from v1:** server-side signing moves into a dedicated API route since `page.tsx` is a client component. Iframe URL targets `/_sidecar/webui-login` (not `/?dashboard_token=`).

**Goal:** Add the dashboard side: API route returns signed sidecar-handoff URL, client iframe component fetches that URL on mount and sets iframe src.

**Files to modify (in `Hermesdeploy/dashboard`):**

1. **New file:** [src/lib/webui-handoff.ts](Hermesdeploy/dashboard/src/lib/webui-handoff.ts) — modeled on [src/lib/official-dashboard-handoff.ts](Hermesdeploy/dashboard/src/lib/official-dashboard-handoff.ts).
   ```typescript
   import { createHmac, randomBytes } from 'crypto'
   
   // [REVISED v3] match OFFICIAL_DASHBOARD_LOGIN_TTL_MS = 30_000 (the existing precedent).
   // Sidecar's tolerance (DASHBOARD_LOGIN_TTL_MS = 60_000) gives a 30s grace window
   // for clock skew / browser request latency.
   export const WEBUI_HANDOFF_TTL_MS = 30_000
   
   function buildWebuiLoginPayload(expiresAt: number, nonce: string, nextPath: string): string {
     return `${expiresAt}.${nonce}.${nextPath}`
   }
   
   export function signWebuiHandoffUrl(params: {
     fqdn: string
     apiServerKey: string
     nextPath?: string  // default '/'
   }): { url: string; expiresAt: number; nonce: string } {
     const expiresAt = Date.now() + WEBUI_HANDOFF_TTL_MS
     const nonce = randomBytes(16).toString('hex')
     const nextPath = params.nextPath ?? '/'
     const sig = createHmac('sha256', params.apiServerKey)
       .update(buildWebuiLoginPayload(expiresAt, nonce, nextPath))
       .digest('hex')
     const url = `https://${params.fqdn}/_sidecar/webui-login` +
       `?exp=${expiresAt}&nonce=${nonce}&next=${encodeURIComponent(nextPath)}&sig=${sig}`
     return { url, expiresAt, nonce }
   }
   
   // For tests + sidecar parity-check
   export function verifyWebuiHandoffSignature(params: {
     expiresAt: number
     nonce: string
     nextPath: string
     signature: string
     apiServerKey: string
   }): boolean { /* timing-safe HMAC compare */ }
   ```
   Tests: [src/lib/__tests__/webui-handoff.test.ts](Hermesdeploy/dashboard/src/lib/__tests__/webui-handoff.test.ts) — sign + verify round-trip, expired (verifier doesn't check expiry, but URL contains it for sidecar to enforce), tampered sig.

2. **New API route:** [src/app/api/instances/[id]/webui-login-url/route.ts](Hermesdeploy/dashboard/src/app/api/instances/[id]/webui-login-url/route.ts).
   - Auth: existing user-instance ownership check (mirror what `/api/instances/[id]/official-dashboard/route.ts` does).
   - Decrypt `apiServerKey` via existing path.
   - Compute `fqdn` from instance (existing `gateway_url` resolution).
   - Call `signWebuiHandoffUrl({ fqdn, apiServerKey, nextPath: '/' })`.
   - Return `{ url, expiresAt }` JSON. Cache-Control: no-store.
   - Tests: `__tests__/route.test.ts` covers happy path, unauth, missing instance, expired token TTL boundary.

3. **New client component:** [src/components/webui/WebuiIframe.tsx](Hermesdeploy/dashboard/src/components/webui/WebuiIframe.tsx). [REVISED v3 — sandbox includes `allow-downloads`, recovery from sidecar restart]
   ```tsx
   'use client'
   import { useCallback, useEffect, useRef, useState } from 'react'
   import { trackIframeLoaded, trackIframeError } from '@/lib/telemetry/iframe-events'
   
   export function WebuiIframe({ instanceId }: { instanceId: string }) {
     const [src, setSrc] = useState<string | null>(null)
     const [error, setError] = useState<string | null>(null)
     const iframeRef = useRef<HTMLIFrameElement>(null)
   
     const refreshLoginUrl = useCallback(async () => {
       try {
         const r = await fetch(`/api/instances/${instanceId}/webui-login-url`)
         if (!r.ok) throw new Error(r.statusText)
         const data = await r.json()
         setSrc(data.url)
         setError(null)
       } catch (e) {
         setError(String(e))
       }
     }, [instanceId])
   
     useEffect(() => { refreshLoginUrl() }, [refreshLoginUrl])
   
     // V8 recovery: if sidecar restarts mid-session, browser cookies become invalid
     // and webui requests start 401-ing. Detect via postMessage from a small webui
     // patch OR via periodic health probe; on 401 wave, re-mint URL silently.
     // Simple version: re-fetch URL on iframe `onError` (covers many failure modes).
     const handleIframeError = useCallback(() => {
       trackIframeError(instanceId, 'load')
       refreshLoginUrl()
     }, [instanceId, refreshLoginUrl])
   
     if (error) return <FallbackMessage error={error} retry={refreshLoginUrl} />
     if (!src) return <LoadingShimmer />
     return <iframe
       ref={iframeRef}
       src={src}
       onLoad={() => trackIframeLoaded(instanceId)}
       onError={handleIframeError}
       sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
       allow="clipboard-write; microphone"
       className="h-full w-full border-0" />
   }
   ```
   Tests: smoke test that fetch errors render fallback, fetch success renders iframe with the URL, `onError` triggers re-fetch.

4. **Modify:** [src/app/dashboard/instances/[id]/page.tsx](Hermesdeploy/dashboard/src/app/dashboard/instances/[id]/page.tsx).
   - Add feature flag check (uses whatever flag system already exists in dashboard — Vercel Edge Config? Supabase user_settings? Confirm before implementing).
   - On true: render `<WebuiIframe instanceId={instanceId} />` instead of `<HermesChat />`.
   - On false: keep existing `<HermesChat />` rendering. **Do NOT delete HermesChat in this phase.**
   - Update [src/app/dashboard/chat/page.tsx](Hermesdeploy/dashboard/src/app/dashboard/chat/page.tsx) to redirect to instance page when flag is on.

5. **Feature flag:** add `webuiIframe` to whatever flag system exists. Default OFF.
   - If unclear, simplest: env var `NEXT_PUBLIC_WEBUI_IFRAME_ENABLED=false` plus a Supabase `user_settings.webui_iframe_canary` boolean for per-user override.

**Verification gate:**
- Local: feature flag OFF → existing chat surface renders unchanged.
- Local: feature flag ON + a STUB sidecar that accepts any signed URL and 302s back → iframe loads, request flow works.
- Unit tests: `pnpm test src/lib/__tests__/webui-handoff.test.ts` and the route test — all green.
- Build: `pnpm build` succeeds.

**Rollback:** Feature flag flip OFF (instant). Or git revert.

**Risk to watch:** `apiServerKey` decryption is async; first iframe load latency could be noticeable. Mitigate: page can prefetch the URL during instance-list page mount and pass it through. Acceptable to defer until canary if latency is fine.

---

### Phase 3 — Caddy + sidecar webui-login + dashboard CSP (2-3 days) [REVISED v2]

**HARD PRECONDITION:** Phase 1 deployed to `:stable` image AND V4 + V7 captured.
**Expansion from v1:** now includes sidecar code changes (the auth handoff itself), Caddyfile additions (new matcher + handle block), webui response headers, AND the dashboard CSP `frame-src` update.

**Goal:** Build the sidecar's `handleWebuiLogin` + `webui-session-check` endpoints, wire them into the per-instance Caddyfile, and update dashboard CSP to allow framing per-VM webui.

**Files to modify:**

1. **Sidecar (`Hermesdeploy/dashboard/src/lib/services/sidecar-script.ts`)** — add three new pieces:
   - **`handleWebuiLogin(req, res, requestUrl)`** — mirrors [`handleDashboardLogin`](Hermesdeploy/dashboard/src/lib/services/sidecar-script.ts:434):
     - Reads `exp`, `nonce`, `next`, `sig` from query params.
     - Validates nonce regex, expiry, signature (HMAC-SHA256 with `API_KEY`, payload format identical to dashboard's `signWebuiHandoffUrl()`).
     - Reject if nonce already in `usedWebuiNonces` (NEW separate Map).
     - On valid: `createWebuiSession()` → 302 redirect to `next` with `Set-Cookie: hermes_webui_session=<id>; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=None`.
   - **`handleWebuiSessionCheck(req, res)`** — for Caddy `forward_auth`. Reads cookie, returns 200 if valid session, 401 if not. No body.
   - **Wire into the existing route dispatcher**: where `/_sidecar/dashboard-login` is handled, add `/_sidecar/webui-login` and `/webui-session-check` (forward_auth target).
   - **NEW state**: `usedWebuiNonces: Map<string, number>`, `webuiSessions: Map<string, WebuiSessionRecord>`, `pruneWebuiState()`. Separate from existing dashboard state.
   - Tests: extend the existing sidecar test suite (locate via `grep -r "handleDashboardLogin" __tests__`). Same red-team coverage: valid, expired, tampered, replay.

2. **Caddyfile (`Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:701-892`)** — `buildWebUICaddyfile()`:
   - **Add new matcher**, near the existing `@dashboard_browser`:
     ```
     @webui_browser {
       header_regexp Cookie "(^|;\s*)hermes_webui_session="
     }
     ```
   - **Add new handle block** [REVISED v3 — no `copy_headers Cookie`]:
     ```
     handle @webui_browser {
       forward_auth ${containerName}-dashboard-sidecar:9090 {
         uri /webui-session-check
       }
       reverse_proxy ${containerName}:${WEBUI_INTERNAL_PORT} {
         lb_try_duration 30s
         lb_try_interval 1s
         header_up -Origin
         flush_interval -1
       }
     }
     ```
     Note: Caddy's `forward_auth` clones the original request (including `Cookie`) to the auth endpoint by default. `copy_headers` is for the OPPOSITE direction (auth response → original request) and isn't needed here. The existing `@dashboard_browser` handle works without `copy_headers Cookie`; mirror that pattern exactly.
   - **Add response header for webui-block traffic** [REVISED v3 — exact origins, no wildcard]:
     ```
     header {
       Content-Security-Policy "frame-ancestors 'self' https://hermesos.cloud https://dashboard.hermesos.cloud"
     }
     ```
     Apply globally in the site block (so it's set on all webui responses). **Do NOT use `https://*.hermesos.cloud`** — that would let any hermesos subdomain frame a customer's webui. The dashboard is a fixed origin; list it explicitly.
   - **Inject env**: `HERMES_WEBUI_FRAME_POLICY=ALLOWALL` into webui service env block (around line 947 in `buildWebUIComposeEnv`).
   - **Order matters**: `@webui_browser` must come BEFORE `@authBearer` so cookie-authenticated browser traffic doesn't fall through to bearer-auth path.
   - Tests: extend `__tests__/webui-instance-builder.test.ts` (or wherever Caddyfile output is asserted) — assert presence of new matcher, handle block, response header.

3. **Dashboard CSP** — [next.config.ts:92](Hermesdeploy/dashboard/next.config.ts:92):
   - Update `frame-src` (NOT `frame-ancestors`) to allow per-VM webui:
     ```
     "frame-src 'self' https://js.stripe.com https://*.stripe.com https://*.clerk.accounts.dev https://challenges.cloudflare.com https://stream.mux.com https://*.hermesos.cloud https://*.sslip.io"
     ```
   - Leave `frame-ancestors 'self'` alone — that controls who frames the dashboard, not what the dashboard frames.
   - Optional: keep CSP-Report-Only mode for this phase to catch any unexpected blocks before enforcement.

4. **Fleet rollout** [REVISED v3 — sidecar artifact, not image rebuild]:
   - The sidecar runs `node:22-alpine` with `sidecar_server.js` mounted from a generated artifact (see `artifacts.sidecarServerFile` heredoc at [webui-instance-builder.ts:1230](Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:1230) and the `volumes:` mount at [webui-instance-builder.ts:658](Hermesdeploy/dashboard/src/lib/services/webui-instance-builder.ts:658)).
   - Deploy mechanism: regenerate `sidecar_server.js` (the artifact) → existing `pnpm ops:webui:fleet-live-update` writes it onto each VM → restart the `dashboard-sidecar` container so it picks up the new code.
   - **No image rebuild required** — the alpine base is unchanged. This shortens the deploy cycle and keeps rollback to "regenerate prior artifact + restart".
   - Dry-run on one VM first: `pnpm ops:webui:fleet-live-update --instance-id <id>`. Verify with `docker logs <containerName>-dashboard-sidecar -n 50`.

**Verification gate:**
- One VM updated → from a localhost dashboard with feature flag ON, iframe successfully:
  - Fetches webui-login URL via `/api/instances/[id]/webui-login-url`.
  - Loads `/_sidecar/webui-login?...` and gets 302 with cookie.
  - Subsequent webui requests succeed via cookie auth (200 from sidecar `/webui-session-check`, 200 from webui).
- Bearer-auth flow STILL works for existing dashboard chat code (no regression).
- DevTools shows webui responses include `Content-Security-Policy: frame-ancestors ...`.
- Replay test: capture a `/_sidecar/webui-login` URL from a real load, GET it twice — second request returns 403.
- Tampered test: flip one bit in the `sig` param — sidecar returns 401.
- Expired test: wait >5min after URL mint, GET it — sidecar returns 401.

**Rollback [REVISED v3]:** Regenerate sidecar artifact from previous git commit, run `pnpm ops:webui:fleet-live-update --instance-id <id>` (or fleet-wide), sidecar restarts pick up old code. No image roll required since the base alpine image hasn't changed. Caddyfile rolls back the same way (regenerated from previous commit).

**Risk to watch:**
- Caddy matcher ordering: if `@webui_browser` comes after `@authBearer`, the fall-through eats cookie traffic incorrectly.
- Sidecar nonce stores: if `pruneWebuiState` isn't on a periodic timer (mirroring `pruneDashboardState`), maps grow unbounded. Verify pruning is registered in sidecar startup.
- `forward_auth` adds latency to every iframe request. Measure in canary — should be <5ms in-VM.

---

### Phase 4 — Canary: one VM + one dashboard user (3-5 days observation)

**HARD PRECONDITION:** Phases 0, 1, 2, 3 all merged. V2, V3 still pass.

**Goal:** Ash uses his own instance with the iframe surface for 3-5 days. Real chat usage. Real observation.

**Steps:**
1. Manually flip `webuiIframe` feature flag ON for Ash's user.
2. Pull `:stable` on Ash's VM: `pnpm ops:webui:fleet-pull --instance-id <Ash>`.
3. Apply Caddy update on Ash's VM: `pnpm ops:webui:fleet-live-update --instance-id <Ash>`.
4. Ash uses the iframe-based chat as his daily driver. Logs anything weird.
5. Phase 0 telemetry shows iframe load success rate, auth-exchange success rate, error rate.

**Verification gate:**
- 72 hours of usage with iframe load >99%, auth-exchange >99%.
- No "user-visible regressions" reported by Ash.
- Theme switching works as expected.
- Sessions persist across iframe reloads.

**Rollback:** Feature flag flip OFF, instant revert to legacy chat for Ash.

**Risk to watch:** Subtle interaction between webui's session cookie and dashboard's Supabase cookie (different origins, different domains, but both visible in browser) — verify cookies don't bleed.

**Decision point:** at 72h, Ash decides: ship to fleet (Phase 5) or hold and iterate.

---

### Phase 5 — Fleet rollout (1 day execution + 7 days observation)

**HARD PRECONDITION:** Phase 4 stable for 72h.

**Goal:** Roll out iframe to all paying users.

**Steps:**
1. `pnpm ops:webui:fleet-pull-stable-image` (already exists).
2. `pnpm ops:webui:fleet-live-update` (apply new Caddyfile to entire fleet).
3. Flip `webuiIframe` feature flag globally (default ON).
4. Monitor Phase 0 telemetry for 24h.
5. If error rate <0.5%, declare stable. Otherwise: feature flag OFF, investigate.

**Verification gate:**
- Fleet update touches all VMs without leaving any in a broken state.
- Aggregate error rate < 0.5% for 24h.
- No support-channel reports of broken chat.

**Rollback:** Feature flag flip OFF (instant for all users). Image revert via `fleet-pull-stable-image --digest <prev>` if needed.

**Risk to watch:** A user with an oddball setup (custom env vars, fork of webui-image, manual Caddy edits) may break. Have a triage list and a rollback-per-VM ability.

---

### Phase 6 — Delete dashboard chat code (~2-3 days)

**HARD PRECONDITION:** Phase 5 stable for 7 days. Feature flag has been ON globally with no rollback events.

**Goal:** Remove ~60k LOC of dashboard chat plumbing. The win this entire plan exists for.

**Files/directories to delete (verified by V5):**

API routes:
- [Hermesdeploy/dashboard/src/app/api/conversations/](Hermesdeploy/dashboard/src/app/api/conversations/) (entire dir)
- [Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-start/](Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-start/)
- [Hermesdeploy/dashboard/src/app/api/instances/[id]/send-stream/](Hermesdeploy/dashboard/src/app/api/instances/[id]/send-stream/)
- [Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-stream-resume/](Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-stream-resume/)
- [Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-attachments/](Hermesdeploy/dashboard/src/app/api/instances/[id]/chat-attachments/)
- [Hermesdeploy/dashboard/src/app/api/internal/chat-stream-worker/](Hermesdeploy/dashboard/src/app/api/internal/chat-stream-worker/)

Streaming/proxy infrastructure:
- [Hermesdeploy/dashboard/src/lib/chat-send-stream.ts](Hermesdeploy/dashboard/src/lib/chat-send-stream.ts)
- [Hermesdeploy/dashboard/src/lib/chat-send-stream-events.ts](Hermesdeploy/dashboard/src/lib/chat-send-stream-events.ts)
- [Hermesdeploy/dashboard/src/lib/server-chat-stream-runner.ts](Hermesdeploy/dashboard/src/lib/server-chat-stream-runner.ts)
- [Hermesdeploy/dashboard/src/lib/server-chat-stream-jobs.ts](Hermesdeploy/dashboard/src/lib/server-chat-stream-jobs.ts)
- [Hermesdeploy/dashboard/src/lib/server-chat-stream-outcome.ts](Hermesdeploy/dashboard/src/lib/server-chat-stream-outcome.ts)
- [Hermesdeploy/dashboard/src/lib/chat-stream-worker-auth.ts](Hermesdeploy/dashboard/src/lib/chat-stream-worker-auth.ts)
- [Hermesdeploy/dashboard/src/lib/services/chat-stream-instance-worker-script.ts](Hermesdeploy/dashboard/src/lib/services/chat-stream-instance-worker-script.ts)

Session/message:
- [Hermesdeploy/dashboard/src/lib/hermes-chat-sessions.ts](Hermesdeploy/dashboard/src/lib/hermes-chat-sessions.ts)
- [Hermesdeploy/dashboard/src/lib/hermes-chat-gateway.ts](Hermesdeploy/dashboard/src/lib/hermes-chat-gateway.ts)
- [Hermesdeploy/dashboard/src/lib/chat-session-mirror.ts](Hermesdeploy/dashboard/src/lib/chat-session-mirror.ts)
- [Hermesdeploy/dashboard/src/lib/chat-pending-approval.ts](Hermesdeploy/dashboard/src/lib/chat-pending-approval.ts)
- [Hermesdeploy/dashboard/src/lib/chat-pending-clarify.ts](Hermesdeploy/dashboard/src/lib/chat-pending-clarify.ts)
- [Hermesdeploy/dashboard/src/lib/integrations/chat-handoff.ts](Hermesdeploy/dashboard/src/lib/integrations/chat-handoff.ts)

Safety/encryption/content (verify each in V5):
- [Hermesdeploy/dashboard/src/lib/chat-artifact-safety.ts](Hermesdeploy/dashboard/src/lib/chat-artifact-safety.ts)
- [Hermesdeploy/dashboard/src/lib/chat-crypto.ts](Hermesdeploy/dashboard/src/lib/chat-crypto.ts)
- [Hermesdeploy/dashboard/src/lib/chat-content.ts](Hermesdeploy/dashboard/src/lib/chat-content.ts)
- [Hermesdeploy/dashboard/src/lib/chat-encryption-markers.ts](Hermesdeploy/dashboard/src/lib/chat-encryption-markers.ts)
- [Hermesdeploy/dashboard/src/lib/chat-tool-markers.ts](Hermesdeploy/dashboard/src/lib/chat-tool-markers.ts)
- [Hermesdeploy/dashboard/src/lib/chat-telemetry.ts](Hermesdeploy/dashboard/src/lib/chat-telemetry.ts) — ⚠️ V5 must confirm not used elsewhere
- [Hermesdeploy/dashboard/src/lib/chat-usage.ts](Hermesdeploy/dashboard/src/lib/chat-usage.ts) — ⚠️ V5 must confirm not used elsewhere
- [Hermesdeploy/dashboard/src/lib/chat-attachments.ts](Hermesdeploy/dashboard/src/lib/chat-attachments.ts)
- [Hermesdeploy/dashboard/src/lib/upstream-response-guards.ts](Hermesdeploy/dashboard/src/lib/upstream-response-guards.ts)

WebUI client (~3.8k LOC):
- [Hermesdeploy/dashboard/src/lib/webui/](Hermesdeploy/dashboard/src/lib/webui/) (entire dir)

Chat UI components (~49k LOC):
- [Hermesdeploy/dashboard/src/components/chat/](Hermesdeploy/dashboard/src/components/chat/) (entire dir)

Misc:
- [Hermesdeploy/dashboard/src/lib/agent-error-tips.ts](Hermesdeploy/dashboard/src/lib/agent-error-tips.ts)
- [Hermesdeploy/dashboard/src/lib/hermes-message-ids.ts](Hermesdeploy/dashboard/src/lib/hermes-message-ids.ts)
- [Hermesdeploy/dashboard/src/lib/hermes-upstream-audit.ts](Hermesdeploy/dashboard/src/lib/hermes-upstream-audit.ts)

**Modify (not delete):**
- [Hermesdeploy/dashboard/package.json:49](Hermesdeploy/dashboard/package.json:49) — remove the 4 chat-related tests from `test:hot-paths` (per V6).
- [Hermesdeploy/dashboard/src/app/dashboard/instances/[id]/page.tsx](Hermesdeploy/dashboard/src/app/dashboard/instances/[id]/page.tsx) — remove `<HermesChat />` import and feature flag fallback. Iframe shell becomes the only render path.
- [Hermesdeploy/dashboard/src/app/dashboard/chat/page.tsx](Hermesdeploy/dashboard/src/app/dashboard/chat/page.tsx) — redirect logic stays, fallback path goes.
- Database migration: drop `hermes_conversations` overlay table (in a separate, scheduled migration, not bundled with the deletion PR).

**Verification gate:**
- `pnpm typecheck` passes (no broken imports).
- `pnpm test` passes (no broken tests).
- `pnpm test:hot-paths` passes.
- `pnpm build` succeeds.
- Deploy to Vercel preview, smoke-test the iframe surface end-to-end.
- Code-review the deletion PR carefully — should be one big-but-mechanical PR.

**Rollback:** Git revert. Massive PR but a single revert undoes it cleanly.

**Risk to watch:** A non-chat surface accidentally relied on a "deleted" file (V5's job to catch in advance). If found post-merge, hot-fix to extract the helper.

---

## What NOT to do (avoid relapses)

- ❌ **Do NOT introduce a new "lighter" middle-layer chat proxy in the dashboard.** The point of this plan is to remove the proxy entirely. If a feature seems to need dashboard-side chat code, the answer is to expose it directly from webui (or as a webui plugin), not to recreate the proxy.
- ❌ **Do NOT add `/api/auth/exchange` to webui Python.** [REVISED v2] — auth handoff is in the sidecar, not webui. Keep webui ignorant of the dashboard's existence.
- ❌ **Do NOT inject `API_SERVER_KEY` into the webui container env.** [REVISED v2] — the sidecar has it; webui doesn't need it. Adding it would create drift between webui and the established Caddy-gates-everything pattern.
- ❌ **Do NOT use JWTs for auth handoff.** The dashboard does not have a JWT library; we use HMAC mirroring [src/lib/official-dashboard-handoff.ts](Hermesdeploy/dashboard/src/lib/official-dashboard-handoff.ts). Adding JWT would be an unjustified dependency.
- ❌ **Do NOT delete dashboard chat code in Phase 1-5.** Delete only in Phase 6, after 7 days of fleet stability. The legacy code is the rollback path.
- ❌ **Do NOT use a wildcard CSP `frame-src *`.** It must list per-VM webui origins explicitly (`https://*.hermesos.cloud https://*.sslip.io`).
- ❌ **Do NOT confuse `frame-src` and `frame-ancestors`.** [REVISED v2] — Dashboard's `frame-src` controls what dashboard can frame (needs per-VM webui added). WebUI's response `frame-ancestors` controls who can frame webui (needs dashboard origin added, set in Caddyfile). Dashboard's own `frame-ancestors 'self'` stays — nothing should frame the dashboard from outside.
- ❌ **Do NOT reuse handoff tokens.** The HMAC URL is one-shot per iframe load. Sidecar tracks nonces in `usedWebuiNonces`; reject reuse.
- ❌ **Do NOT share the nonce/session map between dashboard-login and webui-login.** [NEW v2] — Two distinct Maps, two distinct prune functions, two distinct cookie names. Mixing them creates cross-flow replay vulnerabilities.
- ❌ **Do NOT skip the webui upstream catchup before merging custom patches.** Going forward without it accumulates fork drift.
- ❌ **Do NOT change webui's bearer-auth model in this plan.** The cookie handoff is additive — bearer auth still gates direct API calls. They coexist.
- ⚠️ **Be surgical with the webui fork patches** — every line we add to the fork is a line to merge through future upstream changes. The X-Frame-Options config patch is the obvious upstream-PR candidate.

---

## Decision points (ask before improvising) [REVISED v2]

1. **V1 reveals more fork drift than expected:** if `git log origin/master..ash/master` shows significantly more than 7 commits, STOP and ask Ash whether to (a) audit each, (b) hard-reset to upstream and re-apply customizations, or (c) defer the catchup and just patch on current branch.
2. **V3 reveals `apiServerKey` missing from sidecar env:** if dashboard-sidecar doesn't have the key, the official-dashboard handoff shouldn't be working today either. STOP, verify, ask Ash before plan changes.
3. **V7 reveals shared nonce/session state in sidecar:** if dashboard-login and webui-login can't be cleanly separated (e.g. shared rate-limit bucket), STOP and ask Ash whether to namespace nonces (e.g. `dashboard:` / `webui:` prefix) or refactor sidecar state to be per-flow.
4. **Phase 3 finds VMs with custom Caddyfile edits:** if any user has manually edited their Caddyfile, the fleet update will overwrite. Ash decides per-VM.
5. **Phase 3 webui CSP `frame-ancestors` blocks something unexpected:** if Caddy's response header conflicts with a header webui itself sets, STOP and decide whether webui should stop emitting that header (Phase 1 patch) or Caddy should override.
6. **Phase 4 canary error rate >5%:** STOP, do not proceed to Phase 5. Investigate.
7. **Phase 6 deletion PR review reveals an unexpected import:** STOP, extract the helper, then proceed.

---

## Open questions

1. **Should the iframe have `sandbox` attribute?** Tradeoff: better security via origin isolation vs. webui's microphone/clipboard features that need permissions. Investigation shows webui uses Web Speech API for voice. **Initial answer:** use `sandbox="allow-scripts allow-same-origin allow-forms allow-popups"` plus `allow="clipboard-write; microphone"`. Verify in canary.
2. **Should we rate-limit `/_sidecar/webui-login`?** [REVISED v2] — sidecar already has rate-limit posture for dashboard-login (verify). Match it for webui-login. Likely 10/min/IP.
3. **What happens to in-flight chat sessions during fleet rollout?** New users land on iframe; existing users' active streams continue on the legacy code path until they refresh. Verify no broken state if they refresh mid-stream.
4. **Should HermesOS marketing pages be themed to match webui's hermes-deploy theme?** Out of scope for this plan; flag for future.
5. ~~Should we use JWT or HMAC?~~ — Resolved: HMAC mirroring `official-dashboard-handoff.ts`.
6. ~~Should we go same-origin (path-routing) or cross-origin (subdomain)?~~ — Resolved: cross-origin with `SameSite=None; Secure`. Per-VM origins already exist.
7. ~~Should webui mint the session cookie?~~ [v2] — Resolved: NO. Sidecar mints it, Caddy validates via forward_auth.
8. **What's the dashboard's existing feature-flag system?** Need to verify before Phase 2. Likely env var + Supabase user_settings, but confirm.

---

## Estimated effort [REVISED v2]

- Pre-flight: 3h (V1, V5, V6, V7 are minutes each; V2, V3 require Ash to SSH; V4 is 30min)
- Phase 0: 3h
- Phase 1: **1.5 days** (was 3 days in v1) — only theme + frame patches + upstream catchup. No auth code in webui.
- Phase 2: 3 days (handoff helper + API route + client iframe component + feature flag wiring + tests)
- Phase 3: **2-3 days** (was 1 day in v1) — sidecar code + Caddyfile + dashboard CSP + tests + canary VM update
- Phase 4: 3-5 days observation (mostly Ash-time, not Codex-time)
- Phase 5: 1 day execution + 7 days observation
- Phase 6: 2-3 days (deletion PR + tests + review)
- **Total: ~12-14 days focused execution + 10 days observation = ~3.5 weeks elapsed**

Net change from v1: shifted ~1-2 days from Phase 1 (less webui work) to Phase 3 (more sidecar work). Total roughly the same.

**Critical ordering:** V1, V2, V3, V4, V5, V6, V7 → Phase 0 → (Phase 1 ‖ Phase 2) → Phase 3 → Phase 4 (includes V8 sidecar-restart test) → Phase 5 → Phase 6

Phase 1 and Phase 2 can run in parallel (different repos, no shared files). Everything else is strictly sequential.

---

## Handoff notes for executor [REVISED v3]

1. **Read this whole doc before any code changes.** Read v2→v3 and v1→v2 update sections first — they list the changes from prior versions and the reasons.
2. **Run pre-flight V1-V8 in order.** Report results for each. Do NOT start Phase 0 until reviewed by Ash.
3. **Each phase has a verification gate.** Do not merge a phase until its gate passes.
4. **Use telemetry from Phase 0** to prove improvement, not vibes.
5. **If pre-flight fails, STOP, report the contradiction, propose a plan revision. Do not push through on assumptions.** This is the single most important rule in this doc. (This rule is what produced v2 and v3 — Codex caught both rounds of bugs before any code was written.)
6. **When in doubt:** webui is the source of truth for chat state. The dashboard-sidecar is the source of truth for browser-cookie auth. The dashboard is the source of truth for billing and identity. Cross-cutting concerns belong on the webui side post-migration.
7. **Ash has been on this for months.** Do not propose half-measures or deviate from this plan without explicit go-ahead.
8. **Mark user-only items clearly** in your reports. Ash is the only one who can SSH into prod VMs (V2, V3, V8), flip feature flags (Phase 4, 5), and approve the deletion (Phase 6).
9. **WebUI fork patches are ash-fork specific.** Only ONE patch is the obvious upstream-PR candidate: the X-Frame-Options config in `api/helpers.py`. The theme additions stay private. (Auth-exchange endpoint was REMOVED in v2 — no longer applies.)
10. **Theme defaulting is Ash's call.** If, during canary, the default-to-hermes-deploy feels wrong (users want vanilla dark by default), that's a 3-line revert in `boot.js`/`panels.js`/`index.html` — no big deal.

---

## Plan revision history (newest at top)

When reality contradicts the plan, the executor reports back and the plan is revised here:

1. Add a new section directly below this header (above all older revisions)
2. Header: `## vN → vN+1 update — {{1-line summary of what flipped}}`
3. Body: table of "Plan said" vs. "Reality found" with citations + which phases change + new user-blockers if any
4. **DO NOT delete or edit older revisions** — they're traceable history
5. Edit specific phase sections inline above; mark with `[REVISED vN]`
6. Commit the plan revision separately from any code changes

<!-- vN → vN+1 update sections accumulate here as plan evolves -->
