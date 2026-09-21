# Hermes Upstream Sync + TUI Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stabilize Hermes Deploy against the current upstream Hermes Agent main while fixing the broken/confusing TUI path first and then closing the highest-value dashboard drift around commands, skills, and plugins.

**Architecture:** Treat this as two linked tracks. Track A is TUI recovery: reproduce the live failure, surface the exact transport/fallback reason in the UI, and then fix the root cause once reproduced. Track B is upstream product alignment: finish the shared command/capability registry, then reuse it across chat and the Skills surface so commands, skills, and plugins stop drifting apart.

**Tech Stack:** Next.js App Router, React 19, Jest, xterm.js, Hermes agent web API, webui runtime APIs

**Source-of-truth audit context:** Upstream `NousResearch/hermes-agent` main = `8fabef9d358cdaa97408f4f00e0dc6e3511ae97d`, vanilla fork main = `75ab3ecf5e4b4e5c876bd117808e73a31892e0c5`, current Hermes Deploy HEAD at planning time = `57da2c2a40fa8fd6bfc24292573dc12707008e71`.

---

## Do Now

1. TUI root-cause investigation and user-visible fallback diagnostics
2. Shared command/capability registry endpoint
3. Skills page capability surfacing using the shared registry

## Can Wait

1. Advanced Firecrawl controls: `FIRECRAWL_API_URL`, `FIRECRAWL_BROWSER_TTL`
2. Advanced Browserbase controls: `BROWSERBASE_PROXIES`, `BROWSERBASE_ADVANCED_STEALTH`, `BROWSERBASE_KEEP_ALIVE`, `BROWSER_INACTIVITY_TIMEOUT`
3. Self-hosted gateway override fields: `TOOL_GATEWAY_DOMAIN`, `TOOL_GATEWAY_SCHEME`, `TOOL_GATEWAY_USER_TOKEN`
4. Modal-backed terminal/subscription options
5. Full local Chrome/CDP connector workflow beyond status/guidance
6. Curator management UX
7. Provider-by-provider dashboard expansion for LM Studio, GMI Cloud, Azure AI Foundry, MiniMax, Tencent Tokenhub
8. Messaging platform/plugin host administration UI
9. Observability/achievements plugin UX
10. One-shot `hermes -z` dashboard wrapper

## Guardrails

- Keep config and skills management on upstream web APIs via `agentWebApi`
- Do not reintroduce direct gateway writes to `/api/config`
- Do not reintroduce fork-only gateway dependence for `/api/skills`
- No TUI “fix” without a reproducible root cause or transport evidence
- Every shipped fix gets regression coverage
- Commit after each confirmed slice

### Task 1: TUI fallback diagnostics and live repro support

**Files:**
- Modify: `dashboard/src/components/NativeTuiPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/tui/page.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/page.tsx`
- Test: `dashboard/src/components/__tests__/NativeTuiPanel.test.tsx`
- Test: `dashboard/src/app/dashboard/instances/[id]/tui/__tests__/page.test.tsx`
- Test: `dashboard/src/app/dashboard/instances/[id]/__tests__/page.test.tsx`

- [ ] **Step 1: Write failing tests for fallback reason propagation**
  Add tests that prove:
  - `NativeTuiPanel` calls `onFallbackRequested(reason)` with the exact reason text
  - the dedicated TUI page shows a stable-transport warning/banner with that reason
  - the inline instance page shows the same reason after a native-TUI fallback

- [ ] **Step 2: Run the focused TUI tests to confirm the new expectations fail**
  Run:
  ```bash
  cd dashboard && npm test -- --runInBand --runTestsByPath 'src/components/__tests__/NativeTuiPanel.test.tsx' 'src/app/dashboard/instances/[id]/tui/__tests__/page.test.tsx' 'src/app/dashboard/instances/[id]/__tests__/page.test.tsx'
  ```

- [ ] **Step 3: Implement the fallback-reason plumbing**
  Change `onFallbackRequested?: () => void` to `onFallbackRequested?: (reason?: string) => void`, thread the reason into both page surfaces, and render a clear operator-facing explanation when direct TUI falls back to the stable bridge.

- [ ] **Step 4: Re-run the focused TUI tests**
  Run the same command from Step 2 and confirm green.

- [ ] **Step 5: Commit**
  ```bash
  git add dashboard/src/components/NativeTuiPanel.tsx \
    'dashboard/src/app/dashboard/instances/[id]/tui/page.tsx' \
    'dashboard/src/app/dashboard/instances/[id]/page.tsx' \
    dashboard/src/components/__tests__/NativeTuiPanel.test.tsx \
    'dashboard/src/app/dashboard/instances/[id]/tui/__tests__/page.test.tsx' \
    'dashboard/src/app/dashboard/instances/[id]/__tests__/page.test.tsx'
  git commit -m "fix(tui): surface fallback reason in dashboard"
  ```

### Task 2: Live TUI root-cause investigation

**Files:**
- Inspect: `dashboard/src/app/api/instances/[id]/terminal/interactive/route.ts`
- Inspect: `dashboard/src/lib/terminal-gateway.ts`
- Inspect: `dashboard/src/components/NativeTuiPanel.tsx`
- Inspect: `dashboard/src/components/TerminalPanel.tsx`
- Optional modify if root cause is proven: same files plus targeted tests

- [ ] **Step 1: Reproduce on a real running instance**
  Use a real dashboard session and record:
  - whether direct TUI connects
  - whether it falls back immediately
  - the exact fallback reason text
  - whether stable bridge works afterward

- [ ] **Step 2: Identify the failing boundary**
  Classify the failure into one of:
  - signed websocket URL generation
  - browser-to-gateway websocket reachability
  - sidecar refresh/start failure
  - session persistence/restore bug
  - stable bridge attach failure

- [ ] **Step 3: Add the smallest regression test for the actual root cause**
  Prefer route/component tests around the exact boundary instead of broad UI rewrites.

- [ ] **Step 4: Implement only the root-cause fix**

- [ ] **Step 5: Verify focused tests plus the live reproduction**
  Run:
  ```bash
  cd dashboard && npm test -- --runInBand --runTestsByPath 'src/components/__tests__/NativeTuiPanel.test.tsx' 'src/components/__tests__/TerminalPanel.test.tsx' 'src/app/api/instances/[id]/terminal/interactive/__tests__/route.test.ts'
  ```

- [ ] **Step 6: Commit**
  Use a root-cause-specific commit message such as:
  ```bash
  git commit -m "fix(tui): <root cause summary>"
  ```

### Task 3: Shared command/capability registry endpoint

**Files:**
- Create: `dashboard/src/app/api/instances/[id]/command-registry/route.ts`
- Modify: `dashboard/src/lib/command-registry.ts`
- Test: `dashboard/src/app/api/instances/[id]/command-registry/__tests__/route.test.ts`
- Test: `dashboard/src/lib/__tests__/command-registry.test.ts`

- [ ] **Step 1: Write failing tests for a unified server-side registry payload**
  The route should merge:
  - built-in slash commands
  - runtime quick commands
  - installed skills
  - dashboard plugins

- [ ] **Step 2: Confirm the new route tests fail**

- [ ] **Step 3: Implement the route with backend-aware fallbacks**
  Notes:
  - For `webui` backends, reuse runtime/skills/plugin data sources already present.
  - For non-`webui` backends, degrade gracefully to built-ins + any reachable web API sources.
  - Return explicit source/category metadata so chat and skills UI can render the same truth.

- [ ] **Step 4: Run focused tests**
  ```bash
  cd dashboard && npm test -- --runInBand --runTestsByPath 'src/app/api/instances/[id]/command-registry/__tests__/route.test.ts' 'src/lib/__tests__/command-registry.test.ts' 'src/components/chat/__tests__/ChatInput.test.tsx'
  ```

- [ ] **Step 5: Commit**
  ```bash
  git commit -m "feat(commands): add unified capability registry route"
  ```

### Task 4: Move chat onto the shared registry route

**Files:**
- Modify: `dashboard/src/components/chat/ChatInput.tsx`
- Test: `dashboard/src/components/chat/__tests__/ChatInput.test.tsx`

- [ ] **Step 1: Write failing tests for chat consuming the shared registry route first**

- [ ] **Step 2: Update `ChatInput` to fetch the single registry payload instead of composing three separate requests**

- [ ] **Step 3: Verify the chat tests**
  Run:
  ```bash
  cd dashboard && npm test -- --runInBand --runTestsByPath 'src/components/chat/__tests__/ChatInput.test.tsx'
  ```

- [ ] **Step 4: Commit**
  ```bash
  git commit -m "refactor(chat): consume shared command registry"
  ```

### Task 5: Surface capabilities in the Skills page

**Files:**
- Modify: `dashboard/src/app/dashboard/skills/page.tsx`
- Modify: `dashboard/src/components/skills/SkillDiscoveryPanel.tsx`
- Optional create: `dashboard/src/components/skills/CapabilityCatalogPanel.tsx`
- Test: `dashboard/src/components/skills/__tests__/SkillDiscoveryPanel.test.tsx`

- [ ] **Step 1: Add failing tests for capability type/source visibility**
  Cover:
  - skill vs plugin vs built-in/quick-command presentation
  - source labels
  - category browsing that matches chat taxonomy

- [ ] **Step 2: Implement the UI using the shared registry instead of a skills-only mental model**

- [ ] **Step 3: Verify focused skills UI tests**
  Run:
  ```bash
  cd dashboard && npm test -- --runInBand --runTestsByPath 'src/components/skills/__tests__/SkillDiscoveryPanel.test.tsx'
  ```

- [ ] **Step 4: Commit**
  ```bash
  git commit -m "feat(skills): surface unified capability catalog"
  ```

### Task 6: Browser mode polish

**Files:**
- Inspect/modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/config-sections/BrowserEnvironmentBlock.tsx`
- Inspect/modify: `dashboard/src/app/api/instances/[id]/browser-sessions/route.ts`
- Inspect/modify: `dashboard/src/app/api/instances/[id]/browser-stream/route.ts`
- Add focused tests beside modified files

- [ ] **Step 1: Map current browser options against upstream outcomes**
  Group by user intent:
  - local/simple
  - cloud browser
  - persistent/anti-detect
  - Nous gateway-backed
  - advanced CDP attach

- [ ] **Step 2: Add missing status/help text before adding more controls**

- [ ] **Step 3: Add or update focused regression tests**

- [ ] **Step 4: Commit**
  ```bash
  git commit -m "feat(browser): clarify browser mode outcomes"
  ```

## Verification Sweep Before Calling The Phase Done

- [ ] Run focused TUI tests
- [ ] Run focused command registry + chat tests
- [ ] Run focused skills UI tests
- [ ] Run `cd dashboard && npm run typecheck`
- [ ] Run `cd dashboard && npm test -- --runInBand --runTestsByPath 'src/app/dashboard/instances/[id]/tui/__tests__/page.test.tsx' 'src/app/dashboard/instances/[id]/__tests__/page.test.tsx' 'src/components/__tests__/NativeTuiPanel.test.tsx' 'src/components/__tests__/TerminalPanel.test.tsx' 'src/components/chat/__tests__/ChatInput.test.tsx' 'src/components/skills/__tests__/SkillDiscoveryPanel.test.tsx' 'src/lib/__tests__/command-registry.test.ts'`

## Decision Notes For The User

- We should treat the broken TUI as the immediate blocker, but not freeze everything else behind it.
- The first safe move is to surface exact fallback reasons so the live failure stops being opaque.
- The next high-confidence product work is unifying the capability registry across chat and the Skills area.
- The large pile of advanced provider/browser/gateway controls should stay deferred until the main TUI and capability surfaces are stable.
