# Chat Transport Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mixed dashboard chat pipeline with a normalized send-stream architecture that separates transport, frontend rendering, and persistence.

**Architecture:** A new instance-scoped `send-stream` route owns upstream request shaping and stream normalization. The frontend hook consumes only normalized events and updates persisted assistant state separately.

**Tech Stack:** Next.js App Router routes, React hooks, SSE over `fetch`, Supabase persistence, Jest

---

## Task 1: Establish the normalized contract

**Files:**
- Create: `dashboard/src/lib/chat-send-stream-events.ts`
- Create: `dashboard/src/lib/__tests__/chat-send-stream-events.test.ts`

- [x] Define normalized event types for `message`, `chunk`, `thinking`, `tool`, `done`, `error`, `timeout`, and `close`
- [x] Add translation coverage for sparse text, session events, tool lifecycle events, and failure states

## Task 2: Add the new send-stream transport route

**Files:**
- Create: `dashboard/src/lib/chat-send-stream.ts`
- Create: `dashboard/src/app/api/instances/[id]/send-stream/route.ts`
- Create: `dashboard/src/app/api/instances/[id]/send-stream/__tests__/route.test.ts`
- Create: `dashboard/src/lib/responses-proxy-request.ts`

- [x] Add an authenticated instance-aware send-stream route
- [x] Normalize upstream SSE into Hermesdeploy-native events
- [x] Preserve profile-aware routing
- [x] Cover sparse streams, timeout/error events, and request validation in tests

## Task 3: Move the existing hook onto the new route

**Files:**
- Modify: `dashboard/src/components/chat/hooks/useChatStreaming.ts`
- Modify: `dashboard/src/components/chat/hooks/chat-stream.ts`
- Modify: `dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts`

- [x] Switch the main hook from `/responses` to `/send-stream`
- [x] Teach the existing parser to understand normalized events
- [x] Add a hook-level regression test for normalized SSE plus final persistence patching

## Task 4: Remaining hardening

**Files:**
- Delete: the legacy Pages Router `/responses` API endpoint
- Modify: `dashboard/src/components/chat/hooks/chat-persistence.ts`
- Modify: `dashboard/src/components/chat/hooks/useChatStreaming.ts`

- [x] Retire the legacy `/responses` route so it is no longer available as a dashboard chat path
- [ ] Split persistence primitives more explicitly from transport lifecycle handling
- [ ] Add explicit interruption, duplicate-terminal-event, and accepted-but-stalled regression coverage
- [ ] Run focused typecheck and broader chat regression verification

---

## Verification Commands

```bash
cd dashboard
npm test -- --runTestsByPath \
  src/lib/__tests__/chat-send-stream-events.test.ts \
  src/app/api/instances/[id]/send-stream/__tests__/route.test.ts \
  src/components/chat/hooks/__tests__/useChatStreaming.test.ts
```

---

## Notes

- The migration is intentionally incremental: the frontend parser now understands the new contract without deleting the old parsing branches yet.
- The old `/responses` path has been retired after parity checks and transport regression coverage were added around `send-stream`.
- The next high-value step is lifecycle hardening around the normalized `send-stream` path.
