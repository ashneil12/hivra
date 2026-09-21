# Chat Session Contract Overhaul

**Date:** 2026-04-23
**Status:** Approved for implementation planning
**Scope:** Dashboard chat backend contract, upstream Hermes session persistence, refresh/reopen recovery

---

## Goal

Move Hermesdeploy chat to an upstream-backed model where Hermesdeploy owns the UI and a thin compatibility layer, while upstream Hermes owns durable sessions, history, tool events, and long-term chat maintenance.

This supersedes the persistence direction in the 2026-04-20 transport redesign. The normalized `send-stream` route is still the right transport boundary, but Supabase should no longer be the canonical chat transcript once this migration lands.

The practical outcome:

1. refresh keeps the current conversation
2. browser close/reopen restores the last active session
3. completed messages hydrate from upstream Hermes session history
4. Hermesdeploy frontend code stops carrying backend session lifecycle complexity
5. Supabase remains useful as mapping, cache, metadata, and migration compatibility

---

## Upstream Comparison

### Hermes Workspace

Hermes Workspace is the best base for the next contract because it already has the shape Hermesdeploy needs:

- `/api/sessions` for listing, creating, renaming, and deleting sessions
- `/api/history` for loading a session transcript
- `/api/send-stream` for creating/reusing a session and translating upstream events into UI-ready SSE
- `src/server/hermes-api.ts` as a focused adapter around Hermes FastAPI session APIs
- local fallback session storage for portable/local providers

The important pattern is not the exact UI. It is the split:

- backend adapter talks to upstream Hermes
- API routes expose a stable frontend contract
- chat UI consumes session summaries, hydrated messages, and normalized stream events

### Hermes Web UI

Hermes Web UI has more mature Python/static chat handling around existing sessions, cancellation, and stream recovery. It is useful as a reference for lifecycle edge cases, but it is less directly transplantable into the Next.js dashboard.

Use it as a behavior reference, not the primary implementation base.

### Decision

Implement a hybrid:

- copy the Workspace backend contract shape
- keep Hermesdeploy's chat UI shell and instance-aware routing
- use Web UI behavior as a checklist for cancellation, refresh, and recovery hardening

---

## Target Architecture

### Source of truth

Upstream Hermes sessions become canonical for:

- session ids
- message history
- assistant outputs
- tool call lifecycle
- token usage where available
- title/preview metadata where available

Hermesdeploy stores only:

- authenticated user to instance/profile/session mapping
- last active session per user, instance, and profile
- cached session summaries for faster navigation
- UI-only metadata that upstream Hermes does not know about
- temporary migration mirrors for existing Supabase conversation records

### Backend adapter

Add a small dashboard-side adapter, likely under `dashboard/src/lib/`, that wraps upstream Hermes session operations:

- list sessions
- create session
- get session messages
- update/delete session when supported
- stream chat into an existing or newly created session
- normalize upstream message/session payloads into Hermesdeploy types
- expose capability/fallback errors without leaking upstream details to the UI

The adapter should be instance-aware. It should resolve the selected Hermes instance/profile before calling upstream APIs.

### Dashboard API contract

Expose instance-scoped routes that mirror the Workspace contract:

- `GET /api/instances/[id]/sessions`
- `POST /api/instances/[id]/sessions`
- `PATCH /api/instances/[id]/sessions`
- `DELETE /api/instances/[id]/sessions`
- `GET /api/instances/[id]/history?sessionKey=...`
- `POST /api/instances/[id]/send-stream`

These routes should return Hermesdeploy UI-friendly shapes:

- session summaries with `key`, `friendlyId`, `title`, `preview`, `updatedAt`, `messageCount`, and `status`
- chat messages with stable client ids, role, content blocks, timestamps, session key, and tool state
- normalized stream events: `started`, `message`, `chunk`, `thinking`, `tool`, `artifact`, `done`, `error`, and `timeout`

### Frontend contract

The frontend should treat `sessionKey` as the durable chat identity.

`conversationId` can remain during migration, but it should become a compatibility alias rather than the primary identity. The chat hooks should not need to know whether messages came from Supabase, Hermes FastAPI, dashboard fallback, or a local portable provider.

---

## Persistence Model

### Completed messages

On page load or session switch:

1. load session summaries from `/api/instances/[id]/sessions`
2. resolve the active session key from URL state, local UI state, or server-side last-active mapping
3. load messages from `/api/instances/[id]/history`
4. render hydrated upstream messages as the canonical transcript

### Refresh

Refresh should be boring:

- preserve the active session key in URL or persisted user/instance/profile state
- hydrate history from upstream Hermes
- reconcile any in-memory optimistic message with the hydrated transcript

### Browser close/reopen

When the dashboard opens without an explicit session key:

1. find the last active session for the current user, instance, and profile
2. verify it still exists upstream
3. hydrate it
4. fall back to the most recent non-internal upstream session
5. create or show an empty new-session state only when no valid session exists

### Mid-generation refresh

Mid-generation recovery should be handled in two tiers:

1. Prefer upstream session history and run state, if the upstream backend exposes enough information.
2. Keep Hermesdeploy's existing durable server job path as a transitional runner/reconnect aid, but do not make it the long-term transcript source.

If the stream cannot be reattached, the UI should hydrate the last committed upstream messages and show a recoverable "generation may still be running" state instead of fabricating final assistant content.

---

## Migration Strategy

### Slice 1: Design and contract

Create this design spec and review it before code changes.

### Slice 2: Adapter

Add the upstream session adapter with focused tests. This slice should not change the UI yet.

### Slice 3: Instance-scoped sessions and history routes

Add `/sessions` and `/history` routes for a selected instance. Cover auth, missing capabilities, upstream errors, and local fallback behavior.

### Slice 4: Send-stream session identity

Update `send-stream` so it creates/reuses upstream sessions and emits the canonical `sessionKey` in `started`, `chunk`, `tool`, `done`, and `error` events.

### Slice 5: Frontend hydration

Move `useChatConversations`, `chat-persistence`, and `useChatStreaming` to prefer upstream sessions/history. Keep Supabase mirrors only where existing UI or migration code still needs them.

### Slice 6: Refresh and reopen recovery

Persist last active session by user, instance, and profile. Make reload and browser reopen restore from upstream history.

### Slice 7: Hardening

Add cancellation, duplicate terminal event, accepted-but-stalled, local-provider fallback, and profile-switching tests. Use Hermes Web UI as the behavior checklist for these cases.

---

## Testing Plan

Add focused tests for:

- session adapter list/create/history normalization
- instance-scoped sessions route
- instance-scoped history route
- `send-stream` session creation and reuse
- normalized stream event mapping
- refresh hydration using an existing session key
- browser reopen using last-active mapping
- fallback when upstream sessions are unavailable
- compatibility when legacy Supabase conversation ids still appear

Run before each implementation commit:

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

If the full suite is already blocked by unrelated existing work, capture the blocker, run the most relevant focused suite, and do not claim full verification.

---

## Risks

- Existing chat code may still assume Supabase message ids are canonical.
- Branch/edit/retry behavior may depend on local conversation ids.
- Active stream stop/cancel may currently depend on Hermesdeploy server job ids.
- Profile switching could accidentally restore a session from the wrong upstream profile.
- Local provider fallback needs a compatible durable story even when upstream sessions are unavailable.
- Existing headroom removal work is already in the worktree and should not be reverted as part of this overhaul.

---

## Success Criteria

The overhaul is successful when:

- a user can refresh and see the same chat
- a user can close and reopen the browser and land back in the last active chat
- the frontend durable identity is an upstream `sessionKey`
- completed transcripts come from upstream Hermes history
- Supabase is no longer required to reconstruct canonical chat messages
- chat UI changes no longer require repeated backend maintenance across transport, persistence, and session layers at once
