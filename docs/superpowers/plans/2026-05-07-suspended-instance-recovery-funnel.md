# Suspended Instance Recovery Funnel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a polished dashboard recovery funnel for agents paused by compute entitlement enforcement.

**Architecture:** Add a small, focused recovery panel component used by `HermesChat` when `status="stopped"` and `lifecycle_state="suspended"`. Extend public instance typings with entitlement reason fields; the existing API already returns the row fields in full mode.

**Tech Stack:** Next.js, React, Jest, Testing Library, lucide-react.

---

### Task 1: Instance Data Contract

**Files:**
- Modify: `dashboard/src/lib/types/instance.ts`
- Modify: `dashboard/src/components/chat/ChatSidebar.tsx`
- Modify: `dashboard/src/app/api/instances/route.ts`
- Modify: `dashboard/src/app/api/instances/[id]/route.ts`

- [x] Add optional entitlement fields to shared instance types.
- [x] Add entitlement fields to API row interfaces so TypeScript callers can safely consume them.
- [x] Keep secrets out of the response. Do not expose balances or payment identifiers.

### Task 2: Recovery Panel UI

**Files:**
- Create: `dashboard/src/components/chat/InstanceRecoveryPanel.tsx`
- Test: `dashboard/src/components/chat/__tests__/InstanceRecoveryPanel.test.tsx`

- [x] Write a failing test for credit suspension copy and CTAs.
- [x] Write a failing test for token suspension copy.
- [x] Implement the panel with reason mapping, billing links, restart button, and upgrade perks.
- [x] Keep the panel responsive and avoid nested cards.

### Task 3: Wire Into Offline State

**Files:**
- Modify: `dashboard/src/components/chat/HermesChat.tsx`
- Test: `dashboard/src/components/chat/__tests__/HermesChat.test.tsx` if existing mocks require prop updates.

- [x] Render `InstanceRecoveryPanel` for stopped+suspended instances.
- [x] Leave generic "Agent Offline" for manually stopped or unknown stopped instances.
- [x] Ensure Start telemetry remains intact through the panel restart button.

### Task 4: Verification

- [x] Run the focused recovery panel test.
- [x] Run existing chat header/offline tests touched by the change.
- [x] Run typecheck or the narrowest available TypeScript/Jest verification if full typecheck is too slow.
- [x] Commit the complete feature after verification.
