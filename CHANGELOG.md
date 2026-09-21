# Changelog

All notable changes to the Hermes Deploy ecosystem (Dashboard and Agent) will be documented in this file.

---

## [Unreleased]

### Dashboard

#### Changed
- Token page narrative now explains the operator-economy vision before the roadmap, including operator collaboration, self-funding, agent-to-agent payments, Hive Mind, and concrete marketplace examples.

#### Fixed
- Gemini deployments now live-validate Google API keys before provisioning and return actionable setup copy instead of creating an agent that immediately fails with `API_KEY_INVALID`.

---

## [2026-04-12] — Agent Upstream Sync & Migration

### Agent (vanilla-hermes-agent)

#### Reverted / Removed
- **CloakBrowser** support removed from `tools/browser_tool.py` — upstream's native Camoufox `managed_persistence` provides equivalent browser profile persistence and is already configured in Hetzner deployment volumes.
- **`webapi/` module** deleted entirely — was dead code never wired into routing, replaced by the dashboard endpoints grafted onto `api_server.py`.
- **Hardcoded model name fix** in `gateway/run.py` dropped — upstream now ships a clean `_resolve_gateway_model()` that reads from `config.yaml`.
- **Custom `entrypoint.sh` venv patch** dropped — superseded by upstream's robust virtualenv + gosu non-root user architecture.

#### Changed
- **Hard reset to `upstream/main`** — eliminated all accumulated merge cruft from 733+ upstream commits. Fork is now a clean, minimal patch on top of latest upstream.
- **Container user**: upstream now runs as `hermes` (UID 10000), data at `/opt/data/`. Deployment volumes updated to dual-mount both `/root/.hermes/` and `/opt/data/` for compatibility.

#### Re-applied Patches
- **Dockerfile**: `git` added to system dependencies (required for WhatsApp bridge npm deps).
- **CI/CD** (`.github/workflows/docker-publish.yml`): GHCR auto-publish pipeline restored.
- **`api_server.py`**: All dashboard-specific REST endpoints grafted onto clean upstream file:
  - `GET/POST /api/sessions` — list & create sessions
  - `GET /api/sessions/search` — full-text search across messages
  - `GET/PATCH/DELETE /api/sessions/{id}` — session CRUD
  - `GET /api/sessions/{id}/messages` — fetch session message history
  - `POST /api/sessions/{id}/fork` — clone session + history
  - `POST /api/sessions/{id}/chat` — blocking session-aware chat turn
  - `POST /api/sessions/{id}/chat/stream` — SSE streaming chat (primary dashboard endpoint)
  - `GET/POST/PATCH/DELETE /api/memory` — memory store management
  - `GET /api/skills`, `GET /api/skills/categories`, `GET /api/skills/{name}` — skills browser
  - `GET/PATCH /api/config` — live config read/write
  - `GET /api/available-models` — provider model listing

---

## [2026-04-12] — Dashboard Hardening & CI Fixes

### Dashboard (Hermesdeploy)

#### Added
- **`InstanceSettingsPanel.tsx`**: Live instance settings panel — exposes fast mode, gateway timeout, max iterations, and interim assistant messages config directly from the running instance console.
- **`cron-sync-service.ts`**: Background cron job sync service that keeps dashboard cron UI in sync with the agent's job store.
- **`terminal-ssh.ts`**: SSH terminal API handler for in-browser terminal access to running instances.
- **Advanced config options** in `DeployForm.tsx`: Exposed v0.8.0 agent config fields (fast mode, gateway timeout, interim response options) in the deployment form.
- **Hermes trial abuse prevention**: IP-based deduplication in subscription API — repeat trial claimers are silently served paid-upfront checkout payloads.

#### Changed
- **Health probe**: Rewired to bypass Next.js fetch polyfilling so TLS overrides work correctly with self-signed agent HTTPS endpoints.
- **Landing page**: Reverted to the high-converting April 5th layout at `/`; refactored version available at `/v2`.
- **Pricing copy**: All free trial references replaced with "7-day money-back guarantee" site-wide.
- **Model registry** (`models.ts`): Added Xiaomi MiMo and updated provider configs.

#### Fixed
- `cron-sync-service.ts`: Fixed `resolveInstanceIpv4` import path and argument passing.
- `ChatIndexPage`: Fixed `performance.measure` negative timestamp TypeError in Next.js 16.2.1.
- TypeScript build errors from incorrect import paths across several service files.

---

## [2026-04-02] — Browser Security Hardening

### Agent
- **CDP Routing**: Updated `BROWSER_CDP_URL` traffic through internal Caddy instead of direct container exposure.
- **Caddy Exposure**: Removed port `8080` external binding — Caddy's internal server now strictly restricted to `hermes_net` docker network.

### Dashboard
- **VNC/Browser stream**: `BrowserViewer.tsx` updated to fluid full-viewport anchoring.
- **Bash fix**: Escaped `${CLOAK_PROFILE_RESP}` in template literals to fix profile variable interpolation.

---

## [Notes]
- The `qwen-proxy` sidecar is still running on existing Hetzner instances from before the April 12 optimisation pass — these will be pulled and restarted with the new image on next agent deploy.
- Upstream non-root `hermes` user (UID 10000) uses `/opt/data/` as the data path. New deployments target this; existing instances have dual-mounted volumes for compatibility.
