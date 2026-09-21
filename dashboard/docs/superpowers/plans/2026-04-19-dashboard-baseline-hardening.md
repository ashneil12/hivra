# Dashboard Baseline Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a clean dashboard baseline by fixing the confirmed build/test/lint regressions first, then harden the touched checkout/metadata/instance paths with regression coverage.

**Architecture:** Keep the change surface bounded to confirmed failing or recently touched areas. Prefer fixing type narrowing, request/result handling, and test coupling at the lowest layer that explains the failure rather than widening Jest transforms or refactoring unrelated files in the dirty worktree.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Jest with ts-jest, Clerk, Supabase.

---

### Task 1: Profile Deployment Type Narrowing

**Files:**
- Modify: `src/lib/profile-deployment.ts`
- Create or Modify: `src/lib/__tests__/profile-deployment.test.ts`

- [ ] **Step 1: Write the failing test**

Add a focused test that passes profile rows containing `gateway_port: null` and verifies that the returned `profileRoutes` and `profilesToRestore` only contain numeric ports.

- [ ] **Step 2: Run test to verify it fails or reproduces the current mismatch**

Run: `npm test -- --runInBand --runTestsByPath 'src/lib/__tests__/profile-deployment.test.ts'`

Expected: fail before the narrowing fix or demonstrate the missing coverage.

- [ ] **Step 3: Write the minimal implementation**

Refine `getProfileDeploymentState()` so the mapped route arrays are provably `ProfileDeploymentRoute[]` to TypeScript after filtering out null ports.

- [ ] **Step 4: Run focused verification**

Run:
- `npm test -- --runInBand --runTestsByPath 'src/lib/__tests__/profile-deployment.test.ts'`
- `npm run typecheck`

Expected: test passes and the `profile-deployment.ts` type error is gone.

### Task 2: Checkout Activation Flow Stabilization

**Files:**
- Modify: `src/app/get-started/activate/page.tsx`
- Modify: `src/app/get-started/activate/__tests__/page.test.tsx`
- Reference: `src/lib/billing/client.ts`
- Reference: `src/lib/billing/subscribe-errors.ts`

- [ ] **Step 1: Tighten failing tests first**

Ensure the activate-page tests explicitly cover:
- successful checkout bootstrapping,
- legacy canceled URL forwarding,
- active subscription redirect behavior.

- [ ] **Step 2: Run the failing activate-page tests**

Run: `npm test -- --runInBand --runTestsByPath 'src/app/get-started/activate/__tests__/page.test.tsx'`

Expected: reproduce the current failures from the baseline.

- [ ] **Step 3: Fix the root cause minimally**

Align the component logic and/or test harness with the shared `requestSubscriptionCheckout()` contract without reintroducing inline fetch logic. Also remove the current hook dependency lint warning safely.

- [ ] **Step 4: Re-run focused verification**

Run:
- `npm test -- --runInBand --runTestsByPath 'src/app/get-started/activate/__tests__/page.test.tsx'`
- `npm run lint -- --quiet`

Expected: activate-page tests pass and the hook warning is gone.

### Task 3: Checkout Canceled Recovery Hardening

**Files:**
- Modify: `src/app/checkout/canceled/page.tsx`
- Modify: `src/app/checkout/canceled/__tests__/page.test.tsx`
- Reference: `src/lib/billing/client.ts`

- [ ] **Step 1: Confirm the failing redirect expectation**

Run:
`npm test -- --runInBand --runTestsByPath 'src/app/checkout/canceled/__tests__/page.test.tsx'`

Expected: reproduce the current failure around redirecting already-active subscriptions.

- [ ] **Step 2: Fix the smallest layer that is wrong**

Keep checkout retry behavior centralized in `requestSubscriptionCheckout()` and make the page behavior/test expectation consistent with the actual redirect mechanism.

- [ ] **Step 3: Add or keep regression coverage**

Verify tests cover:
- idle canceled state,
- retry success,
- already-active subscription recovery.

- [ ] **Step 4: Re-run focused verification**

Run:
`npm test -- --runInBand --runTestsByPath 'src/app/checkout/canceled/__tests__/page.test.tsx'`

Expected: all canceled-checkout tests pass.

### Task 4: Open Graph Metadata Test Decoupling

**Files:**
- Modify: `src/app/__tests__/open-graph-metadata.test.ts`
- Reference: `src/lib/metadata.ts`
- Reference: metadata-producing route modules under `src/app/blog`, `src/app/features`, and `src/app/compare`
- Optional only if strictly required: `jest.config.ts`

- [ ] **Step 1: Reproduce the current Jest/ESM failure**

Run:
`npm test -- --runInBand --runTestsByPath 'src/app/__tests__/open-graph-metadata.test.ts'`

Expected: current `react-markdown` ESM parse failure.

- [ ] **Step 2: Fix the root cause, not the symptom**

Prefer reducing the test’s dependency on full page modules that import heavy render-only dependencies. If possible, move metadata assertions to helpers or lighter imports rather than broadening Jest transforms.

- [ ] **Step 3: Re-run focused verification**

Run:
`npm test -- --runInBand --runTestsByPath 'src/app/__tests__/open-graph-metadata.test.ts'`

Expected: metadata suite passes without requiring broad ESM transform changes.

### Task 5: Full Baseline Verification

**Files:**
- No new code by default; only touch files proven necessary from previous tasks.

- [ ] **Step 1: Run the focused suites together**

Run:
`npm test -- --runInBand --runTestsByPath 'src/lib/__tests__/profile-deployment.test.ts' 'src/app/get-started/activate/__tests__/page.test.tsx' 'src/app/checkout/canceled/__tests__/page.test.tsx' 'src/app/__tests__/open-graph-metadata.test.ts'`

- [ ] **Step 2: Run full project verification**

Run:
- `npm run typecheck`
- `npm run lint`
- `npm test -- --runInBand`
- `npm run build`

Expected: clean verification output or a short, explicit list of any remaining unrelated failures that were already present and not safely fixable in this bounded pass.

- [ ] **Step 3: Final review**

Review the diff to confirm:
- no unrelated files were modified,
- new tests actually cover the fixed behavior,
- checkout and metadata hardening did not widen coupling,
- the public IPv4 work remains intact.
