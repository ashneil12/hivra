# Hermesdeploy — Upstream Divergence Tracker

**Fork:** `ashneil12/vanilla-hermes-agent`  
**Upstream:** `NousResearch/hermes-agent` (`upstream/main`)  
**Current merge base:** `20f2258f` (`fix(interrupt): propagate to concurrent-tool workers + opt-in debug trace`)  
**Fork head tracked by this repo:** `affccaed`  
**Fork-only commits since base:** `9`  
**Last updated:** 2026-04-22

---

## Scope Note

This workspace does not vendor `vanilla-hermes-agent/` locally. These notes track the live remote fork and the dashboard contracts that depend on it.

---

## How to Use This Document

When upstream moves:
1. Resolve the current merge base between `NousResearch/hermes-agent` and `ashneil12/vanilla-hermes-agent`
2. Compare the fork head against that merge base
3. Update the active patch list below to match the real live diff
4. Refresh `dashboard/hermes_upstream_audit.md` so dashboard-side contract drift stays visible

---

## Active Patches

### PATCH-001: Dashboard REST Overlay
**Files:** `gateway/platforms/api_server.py`  
**Type:** Feature / Compatibility  
**Merge Risk:** ⚠️ Manual — large fork-only surface on an upstream-hot file

**What is live today:**
- dashboard session CRUD and history routes
- dashboard memory CRUD routes
- dashboard skills routes
- dashboard config read/update routes
- curated available-models route
- dashboard SSE chat session route

**Why:** Hermesdeploy still manages sessions, memory, skills, and config through this overlay.

### PATCH-002: Skills Category Helper Restore
**Files:** `gateway/platforms/api_server.py`, `tools/skills_tool.py`, `tests/tools/test_skills_tool.py`  
**Type:** Fix / Compatibility  
**Merge Risk:** Medium

**What is live today:**
- restored `skills_categories()` helper
- `/api/skills/categories` is backed by category names, counts, and optional `DESCRIPTION.md` metadata
- test coverage was added for category enumeration

**Why:** Hermesdeploy still expects category-aware skill browsing from the running agent.

### PATCH-003: Qwen / DashScope Compatibility
**Files:** `hermes_cli/auth.py`, `hermes_cli/config.py`, `hermes_cli/providers.py`, `run_agent.py`  
**Type:** Fix  
**Merge Risk:** Medium

**What is live today:**
- default Qwen base URL points at `https://dashscope.aliyuncs.com/compatible-mode/v1`
- Qwen OAuth refresh requests send a browser-like `User-Agent`
- provider metadata and config prompts describe the DashScope-compatible default
- runtime header injection applies QwenCode-style headers for both legacy Qwen Portal URLs and DashScope-compatible URLs

**Why:** These fixes keep Qwen OAuth-backed inference working after endpoint and WAF changes.

### PATCH-004: GHCR Publish Workflow
**File:** `.github/workflows/docker-publish.yml`  
**Type:** Infrastructure  
**Merge Risk:** Low

**What is live today:**
- smoke-test image build on CI
- publish `ghcr.io/ashneil12/vanilla-hermes-agent:latest` on pushes to `main`
- publish `ghcr.io/ashneil12/vanilla-hermes-agent:${tag}` on release

**Why:** Hermesdeploy consumes this image tag in deployment builders and tests.

---

## No Longer Active

Older tracker entries below are no longer live fork-only diffs and should not be used as merge guidance:

- `tools/browser_tool.py`
- `gateway/run.py`
- `agent/smart_model_routing.py`
- `hermes_cli/gateway.py`
- `gateway/platforms/telegram.py`

---

## File Ownership Map

| File | Owner | Strategy on upstream merge |
|---|---|---|
| `gateway/platforms/api_server.py` | Hermesdeploy | Manual merge always |
| `tools/skills_tool.py` | Hermesdeploy | Preserve category helper |
| `tests/tools/test_skills_tool.py` | Hermesdeploy | Keep coverage in sync with helper |
| `hermes_cli/auth.py` | Shared | Re-check Qwen refresh flow each merge |
| `hermes_cli/config.py` | Shared | Keep Qwen default/base URL copy aligned |
| `hermes_cli/providers.py` | Shared | Re-check provider overlay defaults |
| `run_agent.py` | Shared | Re-check Qwen headers and base URL detection |
| `.github/workflows/docker-publish.yml` | Hermesdeploy | Never replace with upstream |

---

## Merge Runbook

```bash
# 1. Inspect the live fork in a temp clone
git init /tmp/hermes-fork-audit
cd /tmp/hermes-fork-audit
git remote add upstream https://github.com/NousResearch/hermes-agent.git
git remote add fork https://github.com/ashneil12/vanilla-hermes-agent.git
git fetch upstream main
git fetch fork main

# 2. Find the real shared base
merge_base=$(git merge-base upstream/main fork/main)
git show -s --format='%H %cs %s' "$merge_base"

# 3. See what the fork still changes
git diff --name-only "$merge_base"..fork/main

# 4. Update this tracker + the dashboard audit in Hermesdeploy
cd /Users/example/Projects/Hermesdeploy/dashboard
npm run audit:upstream
```
