# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-facing analytics dashboard with token usage charts and estimated cost tracking, backed by trustworthy persisted usage metadata.

**Architecture:** Reuse `hermes_messages` as the v1 analytics source of truth, but first fix the streamed-assistant persistence gap so finalized usage metadata survives PATCH updates. Then add an account-level analytics API that aggregates daily token and estimated cost totals, and render it on a new `/dashboard/analytics` page using lightweight SVG/CSS charts to avoid unnecessary dependencies.

**Tech Stack:** Next.js App Router, legacy Next API route for responses proxy, Supabase, Jest, React 19, TypeScript

---

### Task 1: Fix Message Metadata Persistence

**Files:**
- Modify: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/api/conversations/[conversationId]/messages/[messageId]/route.ts`
- Test: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/api/conversations/[conversationId]/messages/[messageId]/__tests__/route.test.ts`

- [ ] **Step 1: Write the failing test**

Add a test that sends a PATCH payload with `metadata.usage`, `metadata.model`, and `metadata.provider`, and expects the updated row to merge those fields with any existing metadata instead of dropping them.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/app/api/conversations/[conversationId]/messages/[messageId]/__tests__/route.test.ts`
Expected: FAIL because the route ignores `metadata` from the request body.

- [ ] **Step 3: Write minimal implementation**

Update the PATCH route to:
- accept `metadata` from the request body
- fetch existing `metadata`
- merge incoming metadata with existing metadata
- keep the special handling for `reasoning_content`

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/app/api/conversations/[conversationId]/messages/[messageId]/__tests__/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/conversations/[conversationId]/messages/[messageId]/route.ts src/app/api/conversations/[conversationId]/messages/[messageId]/__tests__/route.test.ts
git commit -m "fix: persist chat usage metadata on message updates"
```

### Task 2: Add Analytics Aggregation API

**Files:**
- Create: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/api/analytics/route.ts`
- Create: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/api/analytics/__tests__/route.test.ts`
- Modify: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/api/instances/[id]/stats/route.ts`

- [ ] **Step 1: Write the failing test**

Add tests that verify the analytics route:
- authorizes the current user
- aggregates assistant-message `metadata.usage`
- groups usage by day
- computes estimated cost from provider/model metadata
- returns account totals plus per-day chart rows

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/app/api/analytics/__tests__/route.test.ts`
Expected: FAIL because the route does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Implement `/api/analytics` to:
- fetch the user’s instances and conversations
- fetch assistant messages with `created_at` and `metadata`
- aggregate totals and daily buckets
- compute estimated cost with a small internal pricing map
- tolerate missing provider/model by counting tokens but marking cost as partial

Optionally keep `/api/instances/[id]/stats` as-is for the console stats tab, or enrich it only if needed without changing its response shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/app/api/analytics/__tests__/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/analytics/route.ts src/app/api/analytics/__tests__/route.test.ts
git commit -m "feat: add analytics aggregation api"
```

### Task 3: Add Analytics Dashboard UI

**Files:**
- Create: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/dashboard/analytics/page.tsx`
- Modify: `/Users/example/Documents/Hermesdeploy/dashboard/src/components/layout/DashboardSidebar.tsx`
- Create: `/Users/example/Documents/Hermesdeploy/dashboard/src/app/dashboard/analytics/__tests__/page.test.tsx`

- [ ] **Step 1: Write the failing test**

Add a rendering test for the analytics page that expects:
- summary cards for total tokens and estimated cost
- a daily usage chart section
- a daily cost chart section
- model and instance breakdown sections

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/app/dashboard/analytics/__tests__/page.test.tsx`
Expected: FAIL because the page does not exist yet.

- [ ] **Step 3: Write minimal implementation**

Create a server-rendered page that fetches `/api/analytics` data and renders:
- summary cards
- simple lightweight charts using div/SVG bars or polylines
- empty state when no usage exists

Add a sidebar link to `/dashboard/analytics`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/app/dashboard/analytics/__tests__/page.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/dashboard/analytics/page.tsx src/components/layout/DashboardSidebar.tsx src/app/dashboard/analytics/__tests__/page.test.tsx
git commit -m "feat: add analytics dashboard"
```

### Task 4: Verify End-to-End Behavior

**Files:**
- Modify: `/Users/example/Documents/Hermesdeploy/dashboard/src/components/chat/hooks/useChatStreaming.ts` (only if tests show provider/model metadata still missing from finalized assistant messages)
- Test: relevant targeted suites only

- [ ] **Step 1: Write the failing test**

If needed, add a focused regression test proving finalized streamed assistant messages preserve `usage`, `provider`, and `model` metadata through the persistence path.

- [ ] **Step 2: Run test to verify it fails**

Run the smallest relevant Jest target for the streaming/persistence path.
Expected: FAIL only if the provider/model metadata is not currently persisted.

- [ ] **Step 3: Write minimal implementation**

Only if necessary, enrich the finalized assistant message metadata in `useChatStreaming.ts` with provider/model values already known in the UI/runtime path.

- [ ] **Step 4: Run test to verify it passes**

Run the same targeted Jest suite and confirm PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/chat/hooks/useChatStreaming.ts
git commit -m "fix: preserve analytics metadata for streamed replies"
```

### Task 5: Final Verification

**Files:**
- Verify only

- [ ] **Step 1: Run targeted tests**

Run:
- `npm test -- --runInBand src/app/api/conversations/[conversationId]/messages/[messageId]/__tests__/route.test.ts`
- `npm test -- --runInBand src/app/api/analytics/__tests__/route.test.ts`
- `npm test -- --runInBand src/app/dashboard/analytics/__tests__/page.test.tsx`

Expected: PASS

- [ ] **Step 2: Run broader safety checks**

Run:
- `npm test -- --runInBand src/app/api/instances/[id]/stats/route.test.ts` if added
- `npm test -- --runInBand src/components/layout/__tests__/DashboardSidebar.test.tsx`

Expected: PASS

- [ ] **Step 3: Run lint on changed files or full lint if fast enough**

Run: `npm run lint`
Expected: exit code 0

- [ ] **Step 4: Review diff**

Run: `git diff --stat` and `git diff -- <changed files>`
Expected: only analytics-related and persistence-related changes

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "feat: add analytics dashboard with usage and cost tracking"
```
