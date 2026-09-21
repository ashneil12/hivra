# Persistent Deployment Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the disposable `BOOTSTRAP.md` onboarding ritual with a one-time deployment prompt that preserves the same wording and intent while letting chats start normally.

**Architecture:** The deployment script will seed Hermes with a persistent prompt file instead of creating and later deleting `BOOTSTRAP.md`. The chat client will stop injecting bootstrap-only reminders so first conversations behave like ordinary chats, while tests move from bootstrap-specific assertions to persistent-prompt assertions.

**Tech Stack:** Next.js App Router, React client hooks, TypeScript, Jest

---

### Task 1: Lock in deployment prompt expectations with tests

**Files:**
- Modify: `src/__tests__/hetzner-service.test.ts`

- [ ] **Step 1: Write the failing test**

Add assertions that `renderUserData` writes a persistent prompt artifact instead of `BOOTSTRAP.md`, keeps the existing personality/onboarding wording, and no longer contains bootstrap janitor or deletion instructions.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/__tests__/hetzner-service.test.ts`
Expected: FAIL because the script still contains `BOOTSTRAP.md` creation and janitor cleanup.

- [ ] **Step 3: Write minimal implementation**

Update deployment script generation to write a persistent prompt file and remove bootstrap cleanup behavior.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/__tests__/hetzner-service.test.ts`
Expected: PASS

### Task 2: Lock in normal chat behavior with tests

**Files:**
- Modify: `src/__tests__/chat-bootstrap.test.ts`
- Modify: `src/components/chat/hooks/chat-bootstrap.ts`
- Modify: `src/components/chat/hooks/useChatEngine.ts`

- [ ] **Step 1: Write the failing test**

Change the chat bootstrap tests so they assert plain message pass-through for first messages and removal of bootstrap-specific hidden prompts/reminders.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- --runInBand src/__tests__/chat-bootstrap.test.ts`
Expected: FAIL because the helper still prepends bootstrap reminder text and exports bootstrap-specific prompts.

- [ ] **Step 3: Write minimal implementation**

Remove bootstrap reminder injection and hidden bootstrap prompt usage from the chat hook/module while preserving normal message serialization.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- --runInBand src/__tests__/chat-bootstrap.test.ts`
Expected: PASS

### Task 3: Sanity-check adjacent tests

**Files:**
- Modify: `src/__tests__/chat-engine-state.test.ts` (only if wording needs updating)
- Modify: `src/__tests__/chat-message-visibility.test.ts` (only if wording needs updating)

- [ ] **Step 1: Run related test set**

Run: `npm test -- --runInBand src/__tests__/chat-engine-state.test.ts src/__tests__/chat-message-visibility.test.ts src/__tests__/hetzner-service.test.ts src/__tests__/chat-bootstrap.test.ts`
Expected: any failures should be directly tied to removed bootstrap assumptions.

- [ ] **Step 2: Apply minimal follow-up adjustments**

Only update test descriptions or helper references if bootstrap-specific wording is now misleading.

- [ ] **Step 3: Re-run related test set**

Run: `npm test -- --runInBand src/__tests__/chat-engine-state.test.ts src/__tests__/chat-message-visibility.test.ts src/__tests__/hetzner-service.test.ts src/__tests__/chat-bootstrap.test.ts`
Expected: PASS
