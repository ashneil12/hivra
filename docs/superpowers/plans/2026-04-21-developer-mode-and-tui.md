# Developer Mode and TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class `Managed` vs `Developer` runtime mode, keep root as a separate explicit escalation, reuse the existing dedicated TUI as an independent surface, and add reversible developer recovery flows.

**Architecture:** Store a user-facing `runtimeMode` in instance config and derive existing low-level runtime flags from it where possible. Reuse the current welcome deploy flow, instance PATCH route, advanced console, and dedicated TUI page instead of inventing parallel systems. Treat surface choice (`chat`, `advanced console`, `dedicated TUI`) separately from runtime privilege/persistence.

**Tech Stack:** Next.js App Router, React, TypeScript, Zod, Jest, Testing Library, Supabase-backed instance config, Hetzner deployment builders, xterm/SSE terminal transport.

---

## File Structure

### Core config and deploy model

- Modify: `dashboard/src/lib/instance-settings.ts`
- Modify: `dashboard/src/lib/welcome-deploy.ts`
- Modify: `dashboard/src/lib/services/instance-service.ts`
- Modify: `dashboard/src/app/api/instances/[id]/route.ts`
- Test: `dashboard/src/__tests__/instance-settings.test.ts`
- Test: `dashboard/src/__tests__/instance-settings-root-access.test.ts`
- Test: `dashboard/src/lib/__tests__/welcome-deploy.test.ts`

### Welcome deploy UI

- Modify: `dashboard/src/components/dashboard/welcome/DeployForm.tsx`
- Modify: `dashboard/src/components/dashboard/welcome/styles.ts`
- Modify: `dashboard/src/app/dashboard/welcome/page.tsx`
- Test: `dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx`

### Runtime settings and advanced console

- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`
- Modify: `dashboard/src/components/chat/AgentProfileSettingsPanel.tsx`
- Modify: `dashboard/src/components/chat/InstanceSettingsPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationHostPanel.tsx`

### Surface positioning and terminal polish

- Modify: `dashboard/src/components/chat/ChatHeader.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/page.tsx`
- Modify: `dashboard/src/components/TerminalPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/tui/page.tsx`
- Modify: `dashboard/src/lib/instance-surface-preference.ts`

### Recovery flows

- Modify: `dashboard/src/app/api/instances/[id]/route.ts`
- Modify: `dashboard/src/lib/services/hetzner-instance-builders.ts`
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileDialogs.tsx`
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx`
- Add: `dashboard/src/app/api/instances/[id]/__tests__/route.developer-mode.test.ts` or extend an existing instance route test file if one already exists nearby

---

### Task 1: Add Runtime Mode To Stored Config And Welcome Deploy Defaults

**Files:**
- Modify: `dashboard/src/lib/instance-settings.ts`
- Modify: `dashboard/src/lib/welcome-deploy.ts`
- Modify: `dashboard/src/lib/services/instance-service.ts`
- Modify: `dashboard/src/app/api/instances/[id]/route.ts`
- Test: `dashboard/src/__tests__/instance-settings.test.ts`
- Test: `dashboard/src/__tests__/instance-settings-root-access.test.ts`
- Test: `dashboard/src/lib/__tests__/welcome-deploy.test.ts`

- [ ] **Step 1: Write failing config tests for `runtimeMode`**

Add assertions covering:

```ts
const runtime = getRuntimeAgentSettings({
  agentSettings: { runtimeMode: "developer" }
} as Record<string, unknown>);

expect(runtime.runtimeMode).toBe("developer");
expect(runtime.mountPersistentSource).toBe(true);
expect(runtime.enableRootAccess).toBe(false);
```

Also add a root escalation case:

```ts
const stored = buildStoredInstanceConfig(undefined, {
  agentSettings: {
    runtimeMode: "developer",
    enableRootAccess: true,
  },
});
```

- [ ] **Step 2: Run targeted config tests to verify they fail**

Run:

```bash
pnpm test -- dashboard/src/__tests__/instance-settings.test.ts dashboard/src/__tests__/instance-settings-root-access.test.ts dashboard/src/lib/__tests__/welcome-deploy.test.ts
```

Expected:

- tests fail because `runtimeMode` does not exist yet
- welcome deploy still hardcodes managed behavior only

- [ ] **Step 3: Add `runtimeMode` to the config model**

In `dashboard/src/lib/instance-settings.ts`:

- extend stored/public/runtime agent settings with:

```ts
runtimeMode?: "managed" | "developer";
```

- default it to `"managed"`
- in runtime resolution, derive:
  - `mountPersistentSource = true` when `runtimeMode === "developer"` unless an explicit future override is intentionally supported
  - `enableRootAccess` remains its own boolean

Recommended normalization logic:

```ts
const runtimeMode = stored.runtimeMode === "developer" ? "developer" : "managed";
const mountPersistentSource =
  runtimeMode === "developer" ? true : Boolean(stored.mountPersistentSource);
```

Keep compatibility with existing instances that only store the old booleans.

- [ ] **Step 4: Accept `runtimeMode` through create/update schemas**

In:

- `dashboard/src/lib/services/instance-service.ts`
- `dashboard/src/app/api/instances/[id]/route.ts`

extend `agentSettings` validation with:

```ts
runtimeMode: z.enum(["managed", "developer"]).optional()
```

and ensure `buildAdvancedInstanceConfigPayload()` preserves it.

- [ ] **Step 5: Update welcome deploy defaults to support developer-mode deployment**

In `dashboard/src/lib/welcome-deploy.ts`:

- add a welcome deploy input for `runtimeMode`
- keep the default path as managed
- when developer mode is selected:
  - set `runtimeMode: "developer"`
  - set `enableRootAccess: false`
  - do not treat TUI access as newly unlocked by this flag

Example target shape:

```ts
return {
  ...base,
  runtimeMode,
  enableRootAccess,
  mountPersistentSource: runtimeMode === "developer",
}
```

- [ ] **Step 6: Re-run the targeted config tests**

Run:

```bash
pnpm test -- dashboard/src/__tests__/instance-settings.test.ts dashboard/src/__tests__/instance-settings-root-access.test.ts dashboard/src/lib/__tests__/welcome-deploy.test.ts
```

Expected:

- all updated config tests pass

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/lib/instance-settings.ts dashboard/src/lib/welcome-deploy.ts dashboard/src/lib/services/instance-service.ts dashboard/src/app/api/instances/[id]/route.ts dashboard/src/__tests__/instance-settings.test.ts dashboard/src/__tests__/instance-settings-root-access.test.ts dashboard/src/lib/__tests__/welcome-deploy.test.ts
git commit -m "feat: add developer runtime mode to instance config"
```

---

### Task 2: Add Developer Mode Preset To Welcome Deploy

**Files:**
- Modify: `dashboard/src/components/dashboard/welcome/DeployForm.tsx`
- Modify: `dashboard/src/components/dashboard/welcome/styles.ts`
- Modify: `dashboard/src/app/dashboard/welcome/page.tsx`
- Test: `dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx`

- [ ] **Step 1: Write failing UI tests for the preset block**

Extend `DeployForm.test.tsx` with expectations for:

- a `Developer Mode` expandable/preset control
- default-off behavior
- enabling it reveals sub-copy and default bundle state
- root remains a separate control and starts off

Example assertion shape:

```ts
expect(screen.getByText(/Developer Mode/i)).toBeInTheDocument();
fireEvent.click(screen.getByRole("button", { name: /Enable Developer Mode/i }));
expect(screen.getByText(/persistent developer workspace/i)).toBeInTheDocument();
expect(screen.getByRole("button", { name: /Root Access Off/i })).toBeInTheDocument();
```

- [ ] **Step 2: Run the welcome deploy form test**

Run:

```bash
pnpm test -- dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx
```

Expected:

- new assertions fail because the preset UI does not exist yet

- [ ] **Step 3: Add local state and payload wiring for Developer Mode**

In the welcome page/container that owns deploy state:

- introduce:

```ts
const [runtimeMode, setRuntimeMode] = useState<"managed" | "developer">("managed");
const [enableRootAccess, setEnableRootAccess] = useState(false);
```

- pass these into `DeployForm`
- include them in the final `agentSettings` payload sent during deploy

- [ ] **Step 4: Implement the preset UI in `DeployForm.tsx`**

Add:

- `Developer Mode` master preset
- short copy that it enables a hackable runtime and persistent workspace
- visible default bundle summary
- nested root toggle with stronger warning styling

Recommended copy:

- `Developer Mode`
- `Persistent developer workspace`
- `Root access remains optional and requires redeploy`

Do not gate or relabel the existing dedicated TUI route as part of this preset.

- [ ] **Step 5: Add or update styles without introducing a parallel design system**

In `dashboard/src/components/dashboard/welcome/styles.ts`:

- add styles for the preset card and nested sub-controls
- match the existing welcome deploy look
- keep danger styling reserved for root

- [ ] **Step 6: Re-run the welcome deploy form test**

Run:

```bash
pnpm test -- dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx
```

Expected:

- the new preset tests pass

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/dashboard/welcome/DeployForm.tsx dashboard/src/components/dashboard/welcome/styles.ts dashboard/src/app/dashboard/welcome/page.tsx dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx
git commit -m "feat: add developer mode preset to welcome deploy"
```

---

### Task 3: Unify Runtime Mode Controls In Existing Instance Settings Surfaces

**Files:**
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`
- Modify: `dashboard/src/components/chat/AgentProfileSettingsPanel.tsx`
- Modify: `dashboard/src/components/chat/InstanceSettingsPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationHostPanel.tsx`

- [ ] **Step 1: Add failing UI tests or document manual verification targets**

If nearby tests for these settings panels already exist, extend them. If not, add a focused test around one canonical surface, preferably the runtime/profile settings panel, that verifies:

- `Runtime Mode` shows `Managed` and `Developer`
- root control only appears or becomes enabled in developer mode
- developer copy explains persistence, not TUI gating

If no practical test harness exists yet, create one for the smallest component rather than the full page.

- [ ] **Step 2: Normalize the canonical product language**

Refactor the settings copy from raw low-level toggles toward:

- `Runtime Mode`
  - `Managed`
  - `Developer`
- `Root Access`

Keep low-level implementation booleans only where necessary behind the scenes.

- [ ] **Step 3: Update the chat/profile runtime panel**

In:

- `AgentProfileRuntimeSection.tsx`
- `AgentProfileSettingsPanel.tsx`

replace the root-first presentation with:

- a runtime mode selector
- explanatory copy for developer mode
- a separate root escalation block shown only when `runtimeMode === "developer"`

When saving:

- include `runtimeMode`
- derive `mountPersistentSource` from it for the default profile / instance-level payload

- [ ] **Step 4: Update Advanced Console to use the same model**

In:

- `ConfigurationTab.tsx`
- `ConfigurationHostPanel.tsx`
- `AgentConfigurationTab.tsx`

replace the current paired booleans as the primary control surface with the same `Managed` vs `Developer` model.

Compatibility rule:

- when loading old data, infer:
  - developer mode if `mountPersistentSource === true`
  - otherwise managed

- [ ] **Step 5: Ensure save paths still trigger the correct redeploy behavior**

`runtimeMode` changes should be treated as infrastructure-affecting changes in the same places that currently redeploy for:

- `enableRootAccess`
- `mountPersistentSource`

Update `needsRedeploy()` and any save helpers accordingly.

- [ ] **Step 6: Verify the main settings save path manually**

Run the app and verify:

1. switch an instance from Managed to Developer
2. save
3. confirm the payload includes `runtimeMode: "developer"`
4. confirm restart/redeploy messaging still appears where expected

Expected:

- no duplicate contradictory controls
- runtime mode and root remain separate

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx dashboard/src/components/chat/AgentProfileSettingsPanel.tsx dashboard/src/components/chat/InstanceSettingsPanel.tsx dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationHostPanel.tsx
git commit -m "feat: unify runtime mode controls across instance settings"
```

---

### Task 4: Keep Root As A Strong Explicit Escalation

**Files:**
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileDialogs.tsx`
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`
- Modify: `dashboard/src/components/chat/AgentProfileSettingsPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx`
- Modify: `dashboard/src/app/api/instances/[id]/route.ts`

- [ ] **Step 1: Add a failing test for root escalation confirmation**

At minimum, test the smallest dialog-owning component to verify:

- enabling root from managed mode is blocked
- enabling root from developer mode opens a strong confirmation

Example assertion shape:

```tsx
fireEvent.click(screen.getByRole("button", { name: /Enable Root Access/i }));
expect(screen.getByText(/requires redeploy/i)).toBeInTheDocument();
```

- [ ] **Step 2: Implement a dedicated confirmation path**

Use the existing dialog patterns in `AgentProfileDialogs.tsx` rather than raw `window.confirm`.

Confirmation content should explicitly state:

- full system-level changes
- can break managed behavior
- requires redeploy/restart

- [ ] **Step 3: Prevent invalid combinations in the save layer**

In save logic and/or API normalization:

- if `runtimeMode !== "developer"` then root cannot be persisted as `true`

Recommended safety guard:

```ts
if (runtimeMode !== "developer") {
  enableRootAccess = false;
}
```

Apply this in a central config-normalization location, not only in the UI.

- [ ] **Step 4: Ensure PATCH/POST semantics remain consistent**

For `PATCH /api/instances/[id]`:

- changing root should save config
- UI should mark it as requiring redeploy/restart
- root should not be silently hot-reloaded as if it were a simple runtime tweak

- [ ] **Step 5: Run the related tests**

Run:

```bash
pnpm test -- dashboard/src/__tests__/instance-settings-root-access.test.ts
```

plus any new component test you added for the confirmation flow.

Expected:

- root remains explicit and gated

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/chat/profile-settings/AgentProfileDialogs.tsx dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx dashboard/src/components/chat/AgentProfileSettingsPanel.tsx dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx dashboard/src/app/api/instances/[id]/route.ts dashboard/src/__tests__/instance-settings-root-access.test.ts
git commit -m "feat: require explicit confirmation for root escalation"
```

---

### Task 5: Polish Terminal Surface Positioning Without Re-Gating The TUI

**Files:**
- Modify: `dashboard/src/components/chat/ChatHeader.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/page.tsx`
- Modify: `dashboard/src/components/TerminalPanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/tui/page.tsx`
- Modify: `dashboard/src/lib/instance-surface-preference.ts`

- [ ] **Step 1: Add or extend tests for surface labeling where practical**

Cover at least the pure helper layer if UI tests are too expensive:

- `instance-surface-preference` helpers still route `chat` and `tui` correctly
- dedicated TUI remains reachable independently of runtime mode

If there is already test coverage around the TUI page, extend it; otherwise keep this focused and small.

- [ ] **Step 2: Make the quick terminal honest**

In `ChatHeader.tsx` and `page.tsx`:

- prefer `Advanced Console` language for the quick shell path
- keep `Hermes TUI` / `Dedicated TUI` language for the existing terminal-dominant surface

Do not imply that turning on Developer Mode is required to use the TUI.

- [ ] **Step 3: Simplify `TerminalPanel` presentation**

In `dashboard/src/components/TerminalPanel.tsx`:

- reduce faux-native branding on the shell mode
- keep shell vs TUI session modes visually distinct
- make reconnect and status copy match the new product language

Keep the dedicated full-page TUI route as the primary native-feeling experience.

- [ ] **Step 4: Refine the dedicated TUI page copy**

In `dashboard/src/app/dashboard/instances/[id]/tui/page.tsx`:

- make it clearer that this is a separate workspace for the same instance
- avoid wording that suggests Developer Mode owns access to it
- optionally mention runtime mode only as context, not as a gate

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm test -- dashboard/src/lib/__tests__/welcome-deploy.test.ts
```

plus any new helper/UI tests added for surface routing.

If there is no existing TUI/page test harness, do a manual browser verification:

1. open chat surface
2. open quick TUI modal
3. open dedicated TUI page
4. confirm all still work with `runtimeMode = managed`

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/components/chat/ChatHeader.tsx dashboard/src/app/dashboard/instances/[id]/page.tsx dashboard/src/components/TerminalPanel.tsx dashboard/src/app/dashboard/instances/[id]/tui/page.tsx dashboard/src/lib/instance-surface-preference.ts
git commit -m "feat: clarify advanced console and dedicated TUI surfaces"
```

---

### Task 6: Add Recovery Actions For Developer Mode

**Files:**
- Modify: `dashboard/src/app/api/instances/[id]/route.ts`
- Modify: `dashboard/src/lib/services/hetzner-instance-builders.ts`
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx`
- Modify: `dashboard/src/components/chat/profile-settings/AgentProfileDialogs.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx`
- Test: `dashboard/src/app/api/instances/[id]/__tests__/route.developer-mode.test.ts` or equivalent nearby test file

- [ ] **Step 1: Write failing API tests for recovery actions**

Add coverage for two actions:

- `reset_developer_changes`
- `return_to_managed_mode`

Expected behavior:

- reset clears developer persistence inputs but keeps the instance
- return-to-managed sets `runtimeMode` back to `managed`, clears root, and marks redeploy/restart as required

If the project already has an instance route test file, extend it instead of creating a new one.

- [ ] **Step 2: Decide the action transport explicitly**

Preferred shape: extend the existing `POST /api/instances/[id]` action switch with:

```ts
case "reset_developer_changes":
case "return_to_managed_mode":
```

This avoids introducing a one-off route for closely related instance lifecycle actions.

- [ ] **Step 3: Implement `return_to_managed_mode`**

In the route and config update logic:

- set `runtimeMode` to `"managed"`
- set `enableRootAccess` to `false`
- set `mountPersistentSource` to `false`
- trigger the same redeploy/restart semantics as other infrastructure-affecting changes

- [ ] **Step 4: Implement `reset_developer_changes`**

Define the first safe boundary narrowly:

- clear persistent source/workspace drift and any explicitly developer-owned reset targets
- avoid deleting the whole instance
- keep root off after reset unless there is a very strong reason not to

Because exact reset semantics are the riskiest part of the feature, start with a conservative implementation and document the reset boundary in code comments.

- [ ] **Step 5: Add UI entry points with strong confirmation**

In the runtime settings and/or advanced console:

- show both actions only when `runtimeMode === "developer"`
- use explicit confirmation dialogs
- distinguish:
  - `Reset Developer Changes`
  - `Return to Managed Mode`

- [ ] **Step 6: Run the recovery tests**

Run:

```bash
pnpm test -- dashboard/src/app/api/instances/[id]/__tests__/route.developer-mode.test.ts
```

or the equivalent test target you extended.

Expected:

- recovery actions mutate config predictably
- managed-mode return path clears risky developer settings

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/app/api/instances/[id]/route.ts dashboard/src/lib/services/hetzner-instance-builders.ts dashboard/src/components/chat/profile-settings/AgentProfileRuntimeSection.tsx dashboard/src/components/chat/profile-settings/AgentProfileDialogs.tsx dashboard/src/app/dashboard/instances/[id]/console/tabs/AgentConfigurationTab.tsx
git commit -m "feat: add developer mode recovery actions"
```

---

### Task 7: Final Verification Pass

**Files:**
- Verify only

- [ ] **Step 1: Run the focused automated test suite**

Run:

```bash
pnpm test -- dashboard/src/__tests__/instance-settings.test.ts dashboard/src/__tests__/instance-settings-root-access.test.ts dashboard/src/lib/__tests__/welcome-deploy.test.ts dashboard/src/components/dashboard/welcome/__tests__/DeployForm.test.tsx
```

Expected:

- all targeted feature tests pass

- [ ] **Step 2: Run any instance route tests touched by recovery work**

Run:

```bash
pnpm test -- dashboard/src/app/api/instances/[id]/__tests__/route.developer-mode.test.ts
```

or the route test file you extended.

Expected:

- recovery and runtime-mode route coverage passes

- [ ] **Step 3: Manual browser verification**

Verify end to end:

1. create a managed instance from welcome deploy
2. create a developer-mode instance from welcome deploy
3. switch a running instance from managed to developer
4. enable root and confirm the warning flow
5. open the dedicated TUI while still in managed mode
6. use `Return to Managed Mode`
7. use `Reset Developer Changes`

Expected:

- dedicated TUI is not gated behind developer mode
- developer mode turns on persistence-oriented behavior
- root remains explicit and scary
- recovery paths are obvious and reversible

- [ ] **Step 4: Commit any final fixups**

```bash
git add .
git commit -m "test: verify developer mode and TUI runtime flows"
```

