# WebUI Runtime Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make WebUI-backed instances feel like one coherent system by routing runtime settings and labels through WebUI where available, while keeping Hermes-owned product surfaces clear.

**Architecture:** Add a small runtime ownership layer around existing `dashboard/src/lib/webui/*` helpers, then update route handlers and UI labels to consume that layer. Existing gateway-backed instances keep their current behavior.

**Tech Stack:** Next.js App Router, TypeScript, Supabase, Hermes WebUI HTTP APIs, Jest, React Testing Library.

---

## File Map

- Create: `dashboard/src/lib/webui/runtime-features.ts`
  - Defines WebUI feature availability and human-readable ownership labels.
- Create: `dashboard/src/lib/webui/runtime-settings.ts`
  - Centralizes WebUI runtime model/provider/settings operations so routes do not duplicate WebUI client construction.
- Modify: `dashboard/src/lib/webui/instance.ts`
  - Reuse existing instance resolution but expose enough context for runtime settings calls.
- Modify: `dashboard/src/app/api/instances/[id]/models/route.ts`
  - Use the runtime settings helper and return clear `source: "webui"` metadata.
- Modify: `dashboard/src/app/api/instances/[id]/agent-config/route.ts`
  - Use the runtime settings helper for WebUI settings reads/writes.
- Modify: `dashboard/src/app/api/instances/[id]/profiles/[name]/route.ts`
  - Push provider key changes and model changes through the runtime settings helper.
- Modify: `dashboard/src/components/chat/InstanceSettingsPanel.tsx`
  - Rename confusing gateway labels and show WebUI connected state.
- Modify: `dashboard/src/components/chat/ChatSidebar.tsx`
  - Mark tool-call display and auto-approve as Hermes chat UI preferences, not WebUI runtime settings.
- Test: `dashboard/src/lib/webui/__tests__/runtime-features.test.ts`
- Test: `dashboard/src/lib/webui/__tests__/runtime-settings.test.ts`
- Test: existing route/component tests near the modified files.

## Task 1: Runtime Feature Ownership Contract

**Files:**
- Create: `dashboard/src/lib/webui/runtime-features.ts`
- Test: `dashboard/src/lib/webui/__tests__/runtime-features.test.ts`

- [ ] **Step 1: Write the failing feature ownership tests**

Test that the feature matrix says WebUI owns chat, sessions, models, provider keys, profiles, approvals, commands, memory, projects, workspaces, skills, and crons; Hermes owns vault, billing, deploy, file explorer, advanced console, and product auth.

- [ ] **Step 2: Run the focused test**

Run: `npm test -- --runTestsByPath src/lib/webui/__tests__/runtime-features.test.ts --runInBand`

Expected: fail because the file does not exist.

- [ ] **Step 3: Add the feature ownership module**

Export:

- `type RuntimeOwner = "webui" | "hermes" | "bridge"`
- `WEBUI_RUNTIME_FEATURES`
- `getRuntimeFeatureOwner(feature: string)`
- `getRuntimeFeatureLabel(feature: string, backend: "gateway" | "webui")`
- `isWebUIRuntimeFeature(feature: string)`

- [ ] **Step 4: Run focused test again**

Expected: pass.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

- [ ] **Step 6: Commit**

Commit message: `feat: webui runtime - define feature ownership`

## Task 2: Central WebUI Runtime Settings Helper

**Files:**
- Create: `dashboard/src/lib/webui/runtime-settings.ts`
- Test: `dashboard/src/lib/webui/__tests__/runtime-settings.test.ts`

- [ ] **Step 1: Write failing tests for settings helper**

Cover:

- Resolves a WebUI client with `resolveWebUIInstanceClient`.
- Reads settings with `client.settings()`.
- Saves settings with `client.saveSettings()`.
- Sets default model with `client.setDefaultModel()`.
- Sets provider key with `client.setProviderKey()`.
- Maps `WebUIError` into a safe status/message shape.

- [ ] **Step 2: Run focused test**

Run: `npm test -- --runTestsByPath src/lib/webui/__tests__/runtime-settings.test.ts --runInBand`

Expected: fail because helper does not exist.

- [ ] **Step 3: Implement helper**

Create functions:

- `resolveWebUIRuntime(input)`
- `readWebUIRuntimeSettings(input)`
- `saveWebUIRuntimeSettings(input, settings)`
- `setWebUIDefaultModel(input, model)`
- `setWebUIProviderKey(input, provider, apiKey)`
- `mapWebUIRuntimeError(error, fallbackMessage)`

- [ ] **Step 4: Run focused test again**

Expected: pass.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

- [ ] **Step 6: Commit**

Commit message: `feat: webui runtime - centralize settings adapter`

## Task 3: Route WebUI Models And Settings Through Helper

**Files:**
- Modify: `dashboard/src/app/api/instances/[id]/models/route.ts`
- Modify: `dashboard/src/app/api/instances/[id]/agent-config/route.ts`
- Test: `dashboard/src/app/api/instances/[id]/models/__tests__/route.test.ts`
- Test: `dashboard/src/app/api/instances/[id]/agent-config/__tests__/route.test.ts`

- [ ] **Step 1: Update tests to assert helper usage and response metadata**

Expected WebUI model response should include:

- `source: "webui"`
- `runtime: "webui"`
- `default_model`
- `active_provider`

Expected WebUI settings response should include:

- `source: "webui"`
- `runtime: "webui"`

- [ ] **Step 2: Run focused route tests**

Run: `npm test -- --runTestsByPath src/app/api/instances/[id]/models/__tests__/route.test.ts src/app/api/instances/[id]/agent-config/__tests__/route.test.ts --runInBand`

- [ ] **Step 3: Refactor routes to use runtime helper**

Keep gateway behavior unchanged. Only the `backend === "webui"` branches should change.

- [ ] **Step 4: Run focused route tests again**

Expected: pass.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

- [ ] **Step 6: Commit**

Commit message: `feat: webui runtime - route models and settings through adapter`

## Task 4: Make The Sidebar Labels Honest

**Files:**
- Modify: `dashboard/src/components/chat/InstanceSettingsPanel.tsx`
- Modify: `dashboard/src/components/chat/ChatSidebar.tsx`
- Test: `dashboard/src/components/chat/__tests__/ChatSidebar.test.tsx`
- Test: component test to add or extend for `InstanceSettingsPanel`

- [ ] **Step 1: Add UI tests for WebUI wording**

Assert WebUI-backed instances display:

- "WebUI runtime connected"
- "Sync models from WebUI"
- no "Ping Gateway for Models" label
- "Hermes chat preference" text or accessible label for tool display and auto-approve controls

- [ ] **Step 2: Run focused UI tests**

Run: `npm test -- --runTestsByPath src/components/chat/__tests__/ChatSidebar.test.tsx --runInBand`

- [ ] **Step 3: Update labels and copy**

Use existing UI style. Do not add large explanatory paragraphs.

- [ ] **Step 4: Run focused UI tests again**

Expected: pass.

- [ ] **Step 5: Run full verification**

Run: `npm run verify`

- [ ] **Step 6: Commit**

Commit message: `feat: webui runtime - clarify sidebar ownership`

## Task 5: Tighten Provider Key And Codex Runtime Flow

**Files:**
- Modify: `dashboard/src/app/api/instances/[id]/profiles/[name]/route.ts`
- Modify: `dashboard/src/app/api/instances/[id]/oauth/codex/status/route.ts`
- Modify: `dashboard/src/app/api/instances/[id]/send-stream/route.ts`
- Test: existing profile, Codex OAuth, and send-stream route tests.

- [ ] **Step 1: Add tests for WebUI provider key bridge**

Assert that for WebUI-backed profile updates:

- Vault key is decrypted server-side.
- `setWebUIProviderKey` receives the provider and key.
- `setWebUIDefaultModel` receives the selected model.
- Raw key is not returned in response or logged.

- [ ] **Step 2: Add tests for Codex auth clarity**

Assert Codex failures return a message that explains provider credentials are missing in the WebUI runtime, not a generic server failure.

- [ ] **Step 3: Run focused tests**

Run profile, Codex OAuth, and send-stream route tests by path.

- [ ] **Step 4: Refactor provider/Codex branches through runtime helper**

Do not change legacy gateway behavior.

- [ ] **Step 5: Run focused tests again**

Expected: pass.

- [ ] **Step 6: Run full verification**

Run: `npm run verify`

- [ ] **Step 7: Commit**

Commit message: `feat: webui runtime - bridge provider credentials clearly`

## Task 6: Live WebUI Smoke And Cleanup Decision

**Files:**
- No code unless a live bug is discovered.

- [ ] **Step 1: Verify local dashboard is reachable**

Check `http://localhost:1101`.

- [ ] **Step 2: Verify the WebUI test instance**

Check:

- `/health`
- `/api/models`
- `/api/settings`
- `/api/profiles`
- `/api/sessions`

- [ ] **Step 3: Try one model/provider flow**

Use a non-Codex API-key provider if available, because Codex requires OAuth.

- [ ] **Step 4: Try Codex connect flow**

If it fails, capture the exact failure type and leave the instance running for debugging.

- [ ] **Step 5: Decide which test servers are disposable**

Only delete test instances after:

- dashboard creates records correctly
- WebUI container is healthy
- runtime settings are understandable
- chat succeeds with at least one provider

- [ ] **Step 6: Report plain-English outcome**

Include:

- what is now WebUI-owned
- what remains Hermes-owned
- what still needs a later pass
- any servers left running
