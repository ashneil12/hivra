# Tailscale Private Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a native dashboard flow for customer-owned, host-scoped Tailscale private access without changing the existing public `gateway_url` behavior.

**Architecture:** Introduce a small typed Tailscale metadata surface in instance config, implement host-level Tailscale install/enroll/status helpers behind a dedicated instance API route, and add a new configuration panel in the existing console UI. Keep the current public gateway model intact and explicitly test that Tailscale setup does not rewrite `gateway_url` or break existing instance routes.

**Tech Stack:** Next.js App Router, React 19, TypeScript, Jest, Supabase, SSH-based host orchestration

---

### Task 1: Define Tailscale metadata shape and safe config helpers

**Files:**
- Create: `dashboard/src/lib/private-access/tailscale.ts`
- Create: `dashboard/src/lib/__tests__/tailscale-private-access.test.ts`
- Modify: `dashboard/src/lib/instance-settings.ts`

- [ ] **Step 1: Write the failing helper tests**

Add tests covering:
- a `sanitizeTailscaleConfig` helper that strips any raw `authKey`
- a `buildTailscaleConfigPatch` helper that merges metadata into `config.privateAccess.tailscale`
- a `getPublicTailscaleConfig` helper that returns `undefined` when not configured and never exposes secret-like fields

Run the test file with:

```bash
npm test -- --runInBand src/lib/__tests__/tailscale-private-access.test.ts
```

Expected: FAIL because the new helper module does not exist yet.

- [ ] **Step 2: Implement the helper module**

Create `dashboard/src/lib/private-access/tailscale.ts` with:

- `export type TailscaleAccessState = "disconnected" | "connecting" | "connected" | "error"`
- `export type TailscaleConfig = { enabled: boolean; hostScoped: boolean; state: TailscaleAccessState; machineName?: string; magicDnsName?: string; tailnetName?: string; ipv4?: string; ipv6?: string; sshEnabled?: boolean; tags?: string[]; connectedAt?: string; lastError?: string | null }`
- `export function sanitizeTailscaleConfig(...)`
- `export function buildTailscaleConfigPatch(...)`
- `export function getPublicTailscaleConfig(...)`

Keep the module focused on typed metadata and public-safe shaping only.

- [ ] **Step 3: Wire the typed metadata into instance config helpers**

Update `dashboard/src/lib/instance-settings.ts` so:

- `StoredConfig` explicitly supports `privateAccess?: { tailscale?: TailscaleConfig }`
- `getPublicInstanceConfig(...)` keeps the Tailscale metadata public-safe by routing it through `getPublicTailscaleConfig(...)`

Do not add raw secret storage to `agentSettings` or `memorySystem`.

- [ ] **Step 4: Re-run the helper tests**

Run:

```bash
npm test -- --runInBand src/lib/__tests__/tailscale-private-access.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/private-access/tailscale.ts src/lib/__tests__/tailscale-private-access.test.ts src/lib/instance-settings.ts
git commit -m "feat: add typed tailscale private access metadata helpers"
```

### Task 2: Add host-level Tailscale orchestration helpers with redaction

**Files:**
- Create: `dashboard/src/lib/services/tailscale-private-access.ts`
- Create: `dashboard/src/lib/services/__tests__/tailscale-private-access.test.ts`

- [ ] **Step 1: Write the failing service tests**

Add tests covering:

- install script generation includes Tailscale install/start commands
- enroll script generation uses an environment variable for the auth key instead of embedding it directly into a long-lived file
- status parsing returns `machineName`, `magicDnsName`, `tailnetName`, IPs, and SSH state
- error normalization/redaction removes raw auth keys from surfaced errors

Run:

```bash
npm test -- --runInBand src/lib/services/__tests__/tailscale-private-access.test.ts
```

Expected: FAIL because the service module does not exist yet.

- [ ] **Step 2: Implement the service module**

Create `dashboard/src/lib/services/tailscale-private-access.ts` with focused functions such as:

- `buildTailscaleInstallScript()`
- `buildTailscaleEnrollCommand(params)`
- `buildTailscaleDisableScript()`
- `parseTailscaleStatusJson(raw)`
- `redactTailscaleError(message, authKey)`

Keep it independent from route code so the route can stay thin.

- [ ] **Step 3: Add an explicit status snapshot shape**

In the same module, export a small result type like:

```ts
type TailscaleStatusSnapshot = {
  machineName?: string;
  magicDnsName?: string;
  tailnetName?: string;
  ipv4?: string;
  ipv6?: string;
  sshEnabled?: boolean;
}
```

This is the object the API route should persist into `config.privateAccess.tailscale`.

- [ ] **Step 4: Re-run the service tests**

Run:

```bash
npm test -- --runInBand src/lib/services/__tests__/tailscale-private-access.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/tailscale-private-access.ts src/lib/services/__tests__/tailscale-private-access.test.ts
git commit -m "feat: add tailscale host orchestration helpers"
```

### Task 3: Add the dedicated instance Tailscale API route

**Files:**
- Create: `dashboard/src/app/api/instances/[id]/private-access/tailscale/route.ts`
- Create: `dashboard/src/app/api/instances/[id]/private-access/tailscale/__tests__/route.test.ts`
- Modify: `dashboard/src/app/api/instances/[id]/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing route tests**

Add tests for:

- `GET` returns the current public-safe Tailscale metadata
- `POST` requires auth and instance ownership
- `POST` calls the SSH orchestration path and persists sanitized metadata
- `POST` never echoes the raw `authKey`
- `DELETE` clears stored metadata and calls the disable path
- `POST` leaves the instance `gateway_url` unchanged

Run:

```bash
npm test -- --runInBand src/app/api/instances/[id]/private-access/tailscale/__tests__/route.test.ts
```

Expected: FAIL because the route does not exist yet.

- [ ] **Step 2: Implement the route**

Create `dashboard/src/app/api/instances/[id]/private-access/tailscale/route.ts` that:

- resolves auth + ownership like the other instance routes
- loads the instance and current config
- resolves the host IPv4 using the existing instance/host resolution pattern
- uses `sshExec(...)` plus the Task 2 helpers to:
  - install Tailscale if needed
  - enroll the host using the transient auth key
  - optionally enable Tailscale SSH
  - query status
- stores only sanitized metadata in `config.privateAccess.tailscale`

Use a request body shape like:

```ts
{
  authKey: string;
  machineName?: string;
  tags?: string[];
  enableSsh?: boolean;
}
```

- [ ] **Step 3: Add a focused gateway safety assertion**

In `dashboard/src/app/api/instances/[id]/__tests__/route.test.ts`, add a regression test proving the new Tailscale flow does not change `gateway_url` or the existing public gateway resolution behavior.

- [ ] **Step 4: Re-run the route tests**

Run:

```bash
npm test -- --runInBand src/app/api/instances/[id]/private-access/tailscale/__tests__/route.test.ts src/app/api/instances/[id]/__tests__/route.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/instances/[id]/private-access/tailscale/route.ts src/app/api/instances/[id]/private-access/tailscale/__tests__/route.test.ts src/app/api/instances/[id]/__tests__/route.test.ts
git commit -m "feat: add instance tailscale private access api"
```

### Task 4: Add the dashboard Tailscale panel in the existing configuration UI

**Files:**
- Create: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTailscalePanel.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/tabs/__tests__/ConfigurationTab.test.tsx`
- Modify: `dashboard/src/app/dashboard/instances/[id]/console/__tests__/page.test.tsx`

- [ ] **Step 1: Write the failing UI tests**

Add tests covering:

- the new panel appears inside the existing configuration tab
- the default state explains customer-owned Tailscale in plain English
- enabling opens the short setup form with auth key visible and advanced fields collapsed
- connected state shows status and action buttons
- shared-host warning copy appears when the host is shared

Run:

```bash
npm test -- --runInBand src/app/dashboard/instances/[id]/console/tabs/__tests__/ConfigurationTab.test.tsx src/app/dashboard/instances/[id]/console/__tests__/page.test.tsx
```

Expected: FAIL because the panel does not exist yet.

- [ ] **Step 2: Implement the panel component**

Create `ConfigurationTailscalePanel.tsx` that:

- fetches `/api/instances/${instanceId}/private-access/tailscale`
- renders:
  - default state
  - setup state
  - connected state
  - error state
- keeps the main flow short
- hides developer-oriented fields behind an `Advanced` disclosure

Default advanced fields:

- machine name override
- comma-separated tags
- `Enable Tailscale SSH`

- [ ] **Step 3: Wire the panel into the existing configuration tab**

Update `ConfigurationTab.tsx` to render the new panel next to the existing host/collaboration sections and pass any instance-host context needed for the shared-host warning.

Keep the visual style aligned with the current `interrogation-box` pattern already used by the console tabs.

- [ ] **Step 4: Re-run the UI tests**

Run:

```bash
npm test -- --runInBand src/app/dashboard/instances/[id]/console/tabs/__tests__/ConfigurationTab.test.tsx src/app/dashboard/instances/[id]/console/__tests__/page.test.tsx
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/instances/[id]/console/tabs/ConfigurationTailscalePanel.tsx src/app/dashboard/instances/[id]/console/tabs/ConfigurationTab.tsx src/app/dashboard/instances/[id]/console/tabs/__tests__/ConfigurationTab.test.tsx src/app/dashboard/instances/[id]/console/__tests__/page.test.tsx
git commit -m "feat: add tailscale private access panel to instance settings"
```

### Task 5: Verify no regression to the public gateway model

**Files:**
- Modify: `dashboard/src/lib/services/__tests__/hetzner-instance-builders.test.ts`
- Modify: `dashboard/src/lib/services/__tests__/instance-security.test.ts`
- Modify: `dashboard/src/app/api/instances/[id]/health/__tests__/route.test.ts`

- [ ] **Step 1: Add failing safety assertions**

Add tests proving:

- Tailscale metadata does not affect `resolveGatewayConfiguration(...)`
- instance security/gateway access still prefers the existing `gateway_url`
- instance health checks still use the normal public gateway path and do not assume Tailscale exists

Run:

```bash
npm test -- --runInBand src/lib/services/__tests__/hetzner-instance-builders.test.ts src/lib/services/__tests__/instance-security.test.ts src/app/api/instances/[id]/health/__tests__/route.test.ts
```

Expected: FAIL only if the new Tailscale additions accidentally bleed into existing gateway behavior.

- [ ] **Step 2: Apply the minimal fixes if any safety test fails**

If the new metadata or route wiring leaks into existing gateway logic, keep the fix minimal:

- do not rewrite `gateway_url`
- do not change `resolveGatewayConfiguration(...)`
- do not make health/browser/integration routes depend on Tailscale

- [ ] **Step 3: Re-run the safety tests**

Run:

```bash
npm test -- --runInBand src/lib/services/__tests__/hetzner-instance-builders.test.ts src/lib/services/__tests__/instance-security.test.ts src/app/api/instances/[id]/health/__tests__/route.test.ts
```

Expected: PASS

- [ ] **Step 4: Run the focused full verification set**

Run:

```bash
npm test -- --runInBand \
  src/lib/__tests__/tailscale-private-access.test.ts \
  src/lib/services/__tests__/tailscale-private-access.test.ts \
  src/app/api/instances/[id]/private-access/tailscale/__tests__/route.test.ts \
  src/app/dashboard/instances/[id]/console/tabs/__tests__/ConfigurationTab.test.tsx \
  src/app/dashboard/instances/[id]/console/__tests__/page.test.tsx \
  src/app/api/instances/[id]/__tests__/route.test.ts \
  src/lib/services/__tests__/hetzner-instance-builders.test.ts \
  src/lib/services/__tests__/instance-security.test.ts \
  src/app/api/instances/[id]/health/__tests__/route.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/services/__tests__/hetzner-instance-builders.test.ts src/lib/services/__tests__/instance-security.test.ts src/app/api/instances/[id]/health/__tests__/route.test.ts
git commit -m "test: lock tailscale rollout behind public gateway safety checks"
```

### Task 6: Final verification and cleanup

**Files:**
- Verify only

- [ ] **Step 1: Run lint on changed files or full lint if practical**

Run:

```bash
npm run lint
```

Expected: exit code 0

- [ ] **Step 2: Run a typecheck**

Run:

```bash
npm run typecheck
```

Expected: exit code 0

- [ ] **Step 3: Review the final diff**

Run:

```bash
git diff --stat
git diff -- dashboard/src/lib/private-access/tailscale.ts dashboard/src/lib/services/tailscale-private-access.ts dashboard/src/app/api/instances/[id]/private-access/tailscale/route.ts dashboard/src/app/dashboard/instances/[id]/console/tabs/ConfigurationTailscalePanel.tsx dashboard/src/lib/instance-settings.ts
```

Expected: changes stay tightly scoped to Tailscale metadata, orchestration, API, UI, and regression coverage.

- [ ] **Step 4: Create the final integration commit**

```bash
git add .
git commit -m "feat: add tailscale private access to instance settings"
```

- [ ] **Step 5: Record any follow-up items separately**

If you notice nice-to-have work that is out of scope for v1, capture it separately instead of expanding this plan. Examples:

- private Tailscale web URL routing
- customer-side OAuth minting for short-lived keys
- deeper shared-host management UI
