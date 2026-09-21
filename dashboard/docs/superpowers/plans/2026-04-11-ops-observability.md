# Ops Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal persistent observability layer that records client and server incidents, then exposes them in a gated ops dashboard.

**Architecture:** Introduce an additive `ops_events` Supabase table plus a shared reporting helper that writes deduplicated incidents. Wire the helper into high-value server and client error paths, then add a dashboard page and API route that let the operator inspect recent incidents without replacing existing logs or PostHog.

**Tech Stack:** Next.js App Router, React client components, Supabase, Clerk, PostHog, TypeScript, Jest

---

### Task 1: Lock in ops event reporting behavior with tests

**Files:**
- Create: `src/lib/__tests__/ops-events.test.ts`
- Create: `src/app/api/ops/events/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing tests**

Add tests that verify ops events are redacted, fingerprinted, deduplicated, and that the API route enforces auth plus user/admin scoping.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- --runInBand src/lib/__tests__/ops-events.test.ts src/app/api/ops/events/__tests__/route.test.ts`
Expected: FAIL because the reporting helper and ops API route do not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create the helper and route with the smallest behavior needed to satisfy the tests.

- [ ] **Step 4: Re-run tests**

Run: `npm test -- --runInBand src/lib/__tests__/ops-events.test.ts src/app/api/ops/events/__tests__/route.test.ts`
Expected: PASS

### Task 2: Wire server and client observability into existing flows

**Files:**
- Create: `src/lib/ops-access.ts`
- Create: `src/components/ops/OpsTelemetryProvider.tsx`
- Create: `src/lib/client/ops-events.ts`
- Modify: `src/lib/api-response.ts`
- Modify: `src/app/providers/PostHogProvider.tsx`
- Modify: the dashboard chat transport route that reports proxy failures
- Modify: `src/app/dashboard/layout.tsx`
- Create: `src/app/dashboard/error.tsx`

- [ ] **Step 1: Add failing assertions where practical**

Extend helper tests around route-context reporting and add a UI-level smoke test for the new dashboard error boundary or provider if needed.

- [ ] **Step 2: Implement minimal instrumentation**

Report shared API failures, dashboard runtime exceptions, and high-value chat proxy failures into `ops_events`, keeping changes additive and redacted.

- [ ] **Step 3: Re-run focused tests**

Run: `npm test -- --runInBand src/lib/__tests__/ops-events.test.ts src/app/api/ops/events/__tests__/route.test.ts src/components/layout/__tests__/DashboardSidebar.test.tsx src/components/layout/__tests__/ClientLayoutWrapper.test.tsx`
Expected: PASS

### Task 3: Add the operator-facing incident feed

**Files:**
- Create: `src/app/dashboard/ops/page.tsx`
- Modify: `src/components/layout/ClientLayoutWrapper.tsx`
- Modify: `src/components/layout/DashboardSidebar.tsx`
- Modify: `.env.example`
- Modify: `src/app/privacy/page.tsx`
- Create: `supabase/migrations/20260411190000_ops_events.sql`

- [ ] **Step 1: Implement the page shell and sidebar wiring**

Add a gated ops page with recent-event polling and clear empty/unauthorized states, plus sidebar access for operators.

- [ ] **Step 2: Add schema and policy updates**

Create the migration for `ops_events` and document the admin allowlist environment variable.

- [ ] **Step 3: Verify end-to-end behavior**

Run: `npm test -- --runInBand src/lib/__tests__/ops-events.test.ts src/app/api/ops/events/__tests__/route.test.ts src/components/layout/__tests__/DashboardSidebar.test.tsx src/components/layout/__tests__/ClientLayoutWrapper.test.tsx`
Expected: PASS
