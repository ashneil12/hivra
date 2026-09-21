# Connect Hermes Desktop to a HermesOS instance

Lets an instance owner run the native **Nous Hermes Desktop** app
(<https://hermes-agent.nousresearch.com/desktop>) against their HermesOS-hosted
instance in the app's **"remote gateway"** mode — no local agent install, no
Tailscale, no port-forwarding (we already terminate HTTPS at the edge).

## How it works

The Desktop app's remote mode is driven by two env vars read at **first launch**.
In `apps/desktop/electron/main.cjs`, `startHermes()` calls `resolveRemoteBackend()`
**before** `ensureRuntime()` — so when both are set, the app connects to the
remote backend and **never installs a local agent**:

| Env var | Value we hand the user |
|---|---|
| `HERMES_DESKTOP_REMOTE_URL` | `https://<instance-fqdn>/desktop` |
| `HERMES_DESKTOP_REMOTE_TOKEN` | the instance's `api_server_key` |

The app then probes `GET <url>/api/status` with `Authorization: Bearer <token>`
and opens the gateway WebSocket at `<url>/api/ws?token=<token>`.

### The `/desktop` edge route (the key piece)

The Desktop app speaks the **upstream `hermes dashboard` contract**, which on a
WebUI instance is served by the `official-dashboard` container (`hermes dashboard
--port 9119`) — **not** the webui chat app that the bearer-authed `/api/*` routes
proxy to. So `buildWebUICaddyfile` adds a dedicated edge route
(`webui-instance-builder.ts`):

```
https://<fqdn>/desktop/*  ──(Bearer or ?token= == webuiPassword)──►  official-dashboard:9119
```

`HERMES_DASHBOARD_SESSION_TOKEN` is pinned on the `official-dashboard` service to
the same per-instance `webuiPassword` (= `api_server_key`), so **one token**
satisfies both the edge Caddy bearer check and the web_server's session check.
(Without the pin, `web_server.py` mints a random per-process token nothing
outside the container can know.)

### Why reuse `api_server_key` (and not a separate token)

The edge Caddy's bearer is `webuiPassword`. Making the Desktop bearer the same
value is what lets a single token pass both layers, and it matches the existing
workspace-cloud provisioner (which already sets
`HERMES_DASHBOARD_SESSION_TOKEN = api_server_key`). It's the customer's own
single-tenant instance credential. If we later want a *scoped* Desktop token,
split it into its own `*_encrypted` column + a distinct env var and add a third
matcher to the `/desktop` Caddy block — reversible, no data migration to undo.

## Surfaces

- **Route:** `GET /api/instances/[id]/desktop-connection` → `{ gatewayUrl, token,
  instanceName }` (Clerk auth + ownership via `getSecureUserInstance`,
  WebUI-backed running instances only).
- **UI:** a floating **"Connect Desktop"** button on the instance page (running +
  webui only) opens a modal with per-OS launcher downloads, copyable URL/token,
  and a one-line launch command.
- **Launcher scripts:** `src/lib/webui/desktop-launcher.ts` generates pre-filled
  `.command` / `.sh` / `.ps1` wrappers that set the two env vars and exec the
  installed Desktop binary directly (macOS `open -a` doesn't pass shell env to a
  GUI app).

## Rollout

- **New instances** get the token + `/desktop` route automatically on provision.
- **Existing instances** need **one redeploy** to seed `HERMES_DASHBOARD_SESSION_TOKEN`
  and the new Caddy route. Until then, the Desktop connection won't authenticate
  (the dashboard web_server is still on a random session token). No data change,
  no migration.

## Morning test checklist

1. **Redeploy one WebUI instance** (canary or a throwaway), so it picks up the
   new builder output.
2. On its instance page, confirm the **"Connect Desktop"** button appears; open
   the modal; confirm URL = `https://<fqdn>/desktop` and a token is shown.
3. Install Hermes Desktop, download the macOS launcher from the modal,
   double-click it. **Expected:** the app opens straight into remote mode (no
   local agent install) and shows your instance's sessions.
4. If it doesn't connect, check in order:
   - `curl -H "Authorization: Bearer <token>" https://<fqdn>/desktop/api/status`
     → should return the dashboard status JSON (not 401, not the webui app).
   - Whether `hermes dashboard --insecure` enforces the session token at all
     (if it doesn't, the edge Caddy bearer is still the real gate — fine).
   - The macOS binary path inside `Hermes.app` (the launcher tries
     `Contents/MacOS/Hermes` then the first executable; override with
     `HERMES_APP=/path/to/Hermes.app`).

## Things deliberately left for you

- The exact Desktop **binary path/name** per OS is best-guess (macOS
  `Hermes.app`, Windows `%LOCALAPPDATA%\Programs\Hermes\Hermes.exe`, Linux
  `hermes-desktop`/`hermes` on PATH). The launchers degrade gracefully with an
  override env var; confirm/adjust once you see the installed app.
- Whether to keep reusing `api_server_key` or split a scoped Desktop token (see
  above).
