# browser-sidecar

A deterministic Playwright-driven browser sidecar for HermesOS QA agents. Pro-tier-gated, persistent-session, opinionated tool surface. Deployed as a sibling container in each Pro+ user's WebUI VM; not a multi-tenant cloud service.

## Why this exists

Vex (and other Hermes QA agents) need to log into apps once and reuse the session across every subsequent test run. Re-auth on every run is brittle, costs verification codes, and triggers anti-bot. This sidecar holds the persistent context on disk and exposes a small, deterministic HTTP surface the agent can drive.

The intelligence lives in the agent. The sidecar is dumb on purpose.

## Architecture decisions

- **Playwright Node** with `launchPersistentContext`. One persistent context per identity; multiple sessions share the context with their own page. Apache-2.0, ~600–750MB idle.
- **Sibling container** in the user's WebUI VM. Same docker-compose pattern as the existing chat-durability sidecar.
- **In-VM HTTP** between agent and sidecar. No signed URLs needed — both endpoints sit on the docker network, never exposed externally.
- **Gateway-mediated tool registration**. The `browser_sidecar` tool with endpoint `http://browser-sidecar:8789` is included or excluded from the agent's toolset at session start based on tier.
- **Pro-tier-gated** with four defense layers (see [Tier gating](#tier-gating)).

## Tool surface

All endpoints are `POST` with JSON in/out except `GET /health`.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /health` | — | `{ ok, contexts_active, sessions_active, uptime_s, tier_ok }` |
| `POST /session/start` | `{ identity }` | `{ ok, session_id }` |
| `POST /session/end` | `{ session_id }` | `{ ok }` |
| `POST /goto` | `{ session_id, url }` | `{ ok, current_url, title }` |
| `POST /click_text` | `{ session_id, text, nth? }` | `{ ok }` |
| `POST /click_selector` | `{ session_id, selector }` | `{ ok }` |
| `POST /fill` | `{ session_id, selector, value }` | `{ ok }` |
| `POST /wait_for` | `{ session_id, selector, timeout_ms? }` | `{ ok }` |
| `POST /assert_visible` | `{ session_id, selector? \| text? }` | `{ ok, visible }` |
| `POST /get_text` | `{ session_id, selector }` | `{ ok, text }` |
| `POST /screenshot` | `{ session_id, full_page?, base64? }` | `{ ok, path, base64? }` |
| `POST /run_named_flow` | `{ session_id, flow_id, args? }` | `{ ok, output }` |

Errors return `{ ok: false, error: "<CODE>", message }` with `error` from this set: `SESSION_NOT_FOUND`, `SESSION_EXPIRED`, `TIMEOUT`, `ELEMENT_NOT_FOUND`, `NAVIGATION_FAILED`, `FLOW_NOT_FOUND`, `FLOW_FAILED`, `INVALID_ARGS`, `INTERNAL`.

## Install

Local dev:

```bash
cd services/browser-sidecar
cp .env.example .env
# edit .env — at minimum set SIGNING_SECRET to a random 32+ char string
npm install
npm run playwright:install
npm run dev
```

Container (production shape):

```bash
docker compose up --build
```

## Seeding workflow (the actual blocker we're solving)

Persistent context survives restarts only if you seed it once. The seed step lets Ash (or any operator) handle Clerk MFA / verification interactively.

### Headed seed via SSH (simplest)

```bash
ssh hermes@<user-vm>
docker exec -it browser-sidecar npx hermes-browser seed --identity vex
```

Requires X11 forwarding or running Caddy/noVNC (below).

### noVNC seed (recommended for remote operators)

1. Set `SEED_MODE=true` and re-up the container, or use a separate seed entrypoint.
2. From your local machine:

   ```bash
   curl -X POST https://your-host/api/instances/<id>/browser-sidecar/seed-url \
     -H "Authorization: Bearer <admin-token>" \
     -d '{"identity":"vex"}'
   # => { "url": "https://your-host/browser-sidecar/novnc/vnc.html?ts=...&sig=...&scope=novnc:vex&ttl=600000" }
   ```

3. Open the URL in your browser. **TTL is 10 minutes, hard-coded.** If you need more time, mint a new URL.
4. Log in, handle MFA / verification email manually.
5. The persistent context saves automatically on shutdown.

### Once seeded

Headless flows reuse the cookie + localStorage. `login_clerk` is idempotent — if Clerk has already authed the persistent context, it returns immediately without touching credentials.

## Adding a named flow

Drop a YAML file at `${FLOWS_DIR}/<flow_id>.yaml`. A flow is a list of steps; each step is a primitive tool action with optional args.

Available step types: `goto`, `click_text`, `click_selector`, `fill`, `wait_for`, `assert_visible`, `get_text`, `check_url`, `imap_wait_code`, `log`.

Args support interpolation: `${env:VAR}`, `${args:KEY}` (passed via `/run_named_flow`'s `args`), `${state:KEY}` (set by earlier `get_text`/`imap_wait_code` steps).

Example minimal flow:

```yaml
id: smoke_test_dashboard
steps:
  - type: goto
    args: { url: "${env:DASHBOARD_URL}" }
  - type: assert_visible
    args: { text: "Welcome" }
  - type: screenshot
    args: { full_page: true }
```

Flow files are mounted via the `flows/` volume so you can edit and re-`/run_named_flow` without rebuilding the image.

## Hermes profile integration shape

The `browser_sidecar` tool gets registered in the agent's tool list **at session start**, by the gateway, conditionally on tier. The transport layer is invisible to the SOUL — the agent calls primitives by name; the gateway shim handles the HTTP.

See [vex-soul-snippet.md](./vex-soul-snippet.md) for the SOUL excerpt to add to Vex.

## Tier gating

Four layers, fail-closed:

1. **Provisioning gate.** `webui-instance-builder.ts` only emits the `browser-sidecar` service block when the user's tier is in `{operator, fleet, command}`. Free-tier users do not have the container in their VM.
2. **Container-side revalidation.** Sidecar entrypoint hits the dashboard's `/api/internal/tier-check` on start; non-200 or `tier_ok=false` triggers `process.exit(0)`. Watchdog stops restarting.
3. **API gate.** Dashboard's `/api/instances/[id]/browser-sidecar/*` proxy routes call `requireProTier(userId)` and 403 on free-tier.
4. **Tool gate.** Gateway's `/api/tools` response excludes `browser_sidecar` for free-tier sessions. Agent doesn't know the tool exists.

### Mid-session downgrade behavior

If a user downgrades while their agent has an active session:

1. Tier-change webhook fires.
2. Reconcile job re-renders the WebUI VM compose without the `browser-sidecar` block, runs `docker compose stop browser-sidecar`.
3. The agent's already-registered tool fires its next call → gets `ECONNREFUSED`.
4. Vex's SOUL has a hard rule: any sidecar transport failure returns `BLOCKED`, identical to `SESSION_EXPIRED`.

No silent unauthorized usage. Worst case: one tool call attempt, then BLOCKED for the remainder of the session.

## Security guardrails

- **IMAP credentials** are read from env at module load and never logged. The pino redact list covers the field names; the IMAP error path deliberately suppresses underlying error messages because some IMAP libraries embed the connection URI (with creds) in error strings.
- **IMAP polling window** is hard-clamped to 60 seconds via `IMAP_MAX_POLL_MS` in code. Setting `IMAP_TIMEOUT_MS=...` in env does not extend it — there's no env var that does, on purpose.
- **noVNC signed URL TTL** is hard-coded to 10 minutes in `NOVNC_TTL_MS`. Re-mint a new URL if you need more time. The verifier also caps `maxTtlMs` server-side, so a client minting a longer-claimed TTL gets clamped.
- **Tool args** are redacted before logging via `redactArgs()` — `password`, `secret`, `token`, `auth` keys, and the `value` field on `/fill` payloads (which often hold passwords).
- **Profile data** lives at `${PROFILES_DIR}` (default `/var/lib/hermes-browser/profiles`) inside the container. Mount this on a named volume so it survives restarts. On tier downgrade, the named volume is preserved for 30 days before reclamation (handled by Hermesdeploy reconcile job, not this service).

## Tests

```bash
npm test                  # unit tests; mocked Playwright + IMAP
npm run test:integration  # real Chromium; gated on RUN_INTEGRATION=1
```

The automated integration test seeds a localStorage value, shuts down the SessionManager, restarts it, and verifies the value persists. This is the load-bearing requirement at the persistent-context level — if it fails, nothing else about the sidecar is correct.

It does **not** prove the seeding workflow works against real Clerk (MFA, email verification loop, post-login redirect). The manual test plan below covers that.

### Manual Clerk verification (run before approving Phase 2)

This is the single test that turns the design from "works in mocks" to "works against the real auth system Vex will encounter." It needs valid Clerk credentials for hermesos.cloud (or a throwaway dev tenant), so an operator runs it — not the agent that scaffolded the code.

**Prerequisites:**
- A Clerk-protected URL you can log into (e.g., `https://dashboard.hermesos.cloud/sign-in`).
- Account with email + password, optional email-code MFA.
- IMAP credentials for the inbox that receives Clerk verification codes (Gmail with an app password is fine).

**Steps:**

1. **Configure `.env`** with real values:
   ```
   CLERK_LOGIN_URL=https://dashboard.hermesos.cloud/sign-in
   CLERK_POST_LOGIN_PATH=/dashboard
   CLERK_EMAIL=<your test email>
   CLERK_PASSWORD=<your test password>
   IMAP_HOST=imap.gmail.com
   IMAP_USER=<inbox user>
   IMAP_PASS=<app password>
   SIGNING_SECRET=<32+ char random>
   ```

2. **Build and start the sidecar locally:**
   ```bash
   docker compose up --build -d
   docker logs -f hermes-browser-sidecar    # watch for "browser-sidecar listening"
   ```

3. **Seed in headed mode.** Two options — pick whichever is more convenient:

   **a) noVNC (recommended for fully remote operators):**
   ```bash
   # On the host, run the seed script with --novnc and a public base URL.
   docker exec -it hermes-browser-sidecar npx hermes-browser seed \
     --identity vex-test --novnc --public-base http://localhost:8080
   # Copy the printed URL into your local browser. The TTL is 10 minutes.
   ```
   Open the URL, complete login + MFA in the visible browser. Press Ctrl+C in the terminal when done — the persistent context saves on shutdown.

   **b) Direct headed (if you have X forwarding):**
   ```bash
   docker exec -it hermes-browser-sidecar npx hermes-browser seed \
     --identity vex-test
   ```
   The `login_clerk` flow runs against your real Clerk credentials; complete any MFA in the visible browser.

4. **Verify the persistent context saved.** Profile dir should be non-empty:
   ```bash
   docker exec hermes-browser-sidecar ls /var/lib/hermes-browser/profiles/vex-test/
   # expect: Cookies, Local Storage/, Default/, etc.
   ```

5. **Restart the sidecar to prove the auth survives a process restart:**
   ```bash
   docker compose restart browser-sidecar
   docker logs -f hermes-browser-sidecar
   ```

6. **Hit the auth-gated URL headlessly with a fresh session:**
   ```bash
   SID=$(curl -s -X POST http://127.0.0.1:8789/session/start \
     -H 'content-type: application/json' \
     -d '{"identity":"vex-test"}' | jq -r .session_id)

   curl -s -X POST http://127.0.0.1:8789/goto \
     -H 'content-type: application/json' \
     -d "{\"session_id\":\"$SID\",\"url\":\"https://dashboard.hermesos.cloud/dashboard\"}"

   curl -s -X POST http://127.0.0.1:8789/screenshot \
     -H 'content-type: application/json' \
     -d "{\"session_id\":\"$SID\"}"
   ```

7. **Inspect the screenshot.** The image should show the post-login dashboard, **not** the Clerk sign-in screen. If it shows the sign-in screen, the persistent context did not carry auth across the restart and there's a bug to fix before Phase 2.

**Pass criteria:**
- Step 4: profile dir contains Cookies / Local Storage entries.
- Step 6: `goto` returns `current_url` matching `${CLERK_POST_LOGIN_PATH}` (or any post-login path), not the sign-in URL.
- Step 7: screenshot is the dashboard, not the sign-in form.

**Cleanup:**
```bash
docker exec hermes-browser-sidecar npx hermes-browser logout --identity vex-test || true
docker compose down -v   # wipes the named volume; full reset
```

## Migration note

`agent-browser` and `browser-box` do not exist in the Hermes codebase. There is nothing to migrate from — this is a greenfield service. Agents that want browser tools will get them registered for the first time via the gateway tool-injection path.

## What this is not

- **Not** a generic AI-browser controller. Tool surface is intentionally narrow and adding a primitive requires a justification.
- **Not** a multi-tenant cloud service. One sidecar per user VM. Profile isolation is at the VM boundary.
- **Not** a replacement for Playwright Test. This is a runtime tool surface for live agents, not a CI testing framework.
- **Not** free-tier-eligible. See tier gating.

## Repo location

`Hermesdeploy/services/browser-sidecar/`. Image tag is pinned by the deploy compose, not by source repo split.

## Open questions / future work

- Per-conversation ephemeral profiles (currently only per-identity persistent profiles).
- Profile reset on tier-resume after >30 day downgrade (today: human seeds again).
- Watchdog cron for the in-VM stack (Phase 4).
