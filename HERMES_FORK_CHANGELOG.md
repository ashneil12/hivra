# Hermes Agent: Fork Changelog

This document tracks the live remote fork `ashneil12/vanilla-hermes-agent` relative to upstream `NousResearch/hermes-agent`.

**Current merge base**: `upstream/main` @ `e5dad4ac5` (2026-04-30, v0.12.0)  
**Current fork head**: `ec1d86cf3` (branch `upgrade/upstream-main-2026-04-30`)  
**Fork-only commits since base**: `1` (the merge commit itself, plus pre-merge fork patches preserved)  
**Files currently divergent from upstream**: `8`

---

## Dashboard Chat Integration Note

As of the 2026-05-03 dashboard chat refactor, WebUI-backed chat reads and sends are agent-authoritative:

- chat sessions/history are read through WebUI at port 8787
- browser sends use dashboard `chat-start` plus a signed browser-direct `EventSource` URL
- Postgres chat mirror tables are metadata/deprecated rollback surfaces only, not chat-content truth
- the browser Service Worker and Node sidecar mirror-sync worker no longer own dashboard chat streaming or message persistence

---

## Active Patches

### 1. CI/CD — GHCR Publishing Workflow

**File**: `.github/workflows/docker-publish.yml`

Upstream still does not ship the fork's image publishing workflow. The fork builds, smoke-tests, and publishes:

- `ghcr.io/ashneil12/vanilla-hermes-agent:latest` on pushes to `main`
- `ghcr.io/ashneil12/vanilla-hermes-agent:${tag}` on GitHub releases

This is the image tag Hermesdeploy currently expects in local deployment code and tests.

### 2. `gateway/platforms/api_server.py` — Dashboard REST Overlay

The dashboard still depends on custom REST endpoints grafted onto upstream `APIServerAdapter` without replacing upstream chat/runtime handlers.

**Fork-only responsibilities in this file:**
- session CRUD + session history routes for dashboard chat
- memory CRUD routes
- skills listing and skill detail routes
- skill category route used by the dashboard skills browser
- config read/update routes used by Hermesdeploy
- curated available-models route

The dashboard chat stream still depends on the fork SSE session endpoint:

- `POST /api/sessions/{id}/chat/stream`

### 3. Skills Category Helper Restore

**Files**:
- `gateway/platforms/api_server.py`
- `tools/skills_tool.py`
- `tests/tools/test_skills_tool.py`

The current fork restores a `skills_categories()` helper and wires it back into the gateway skills category route. That helper now returns category names, counts, and optional descriptions from `DESCRIPTION.md` metadata.

This matters because Hermesdeploy still expects category-aware skill browsing from the running agent.

### 4. Qwen / DashScope Compatibility Fixes

**Files**:
- `hermes_cli/auth.py`
- `hermes_cli/config.py`
- `hermes_cli/providers.py`
- `run_agent.py`

The current fork keeps a small set of Qwen-specific compatibility fixes that are not in the upstream base used by the fork:

- default Qwen base URL points at DashScope compatible mode instead of `portal.qwen.ai/v1`
- OAuth refresh requests send a browser-like `User-Agent`
- provider/config metadata advertises the DashScope-compatible default
- runtime header injection applies the Qwen header bundle for both legacy Portal URLs and DashScope-compatible URLs

These patches exist to keep Qwen OAuth-backed inference working after upstream endpoint and WAF behavior changed.

---

## No Longer Divergent

These older fork notes should now be treated as historical, not live patches, because the current remote fork no longer differs from upstream in these areas:

- `tools/browser_tool.py`
- `gateway/run.py`
- `agent/smart_model_routing.py`
- `hermes_cli/gateway.py`
- `gateway/platforms/telegram.py`

---

## Current Divergent Files

- `.github/workflows/docker-publish.yml`
- `gateway/platforms/api_server.py`
- `hermes_cli/auth.py`
- `hermes_cli/config.py`
- `hermes_cli/providers.py`
- `run_agent.py`
- `tests/tools/test_skills_tool.py`
- `tools/skills_tool.py`

---

*Update this document whenever the fork head, merge base, or divergent file list changes.*
