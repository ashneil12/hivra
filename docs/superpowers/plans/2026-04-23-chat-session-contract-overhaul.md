# Chat Session Contract Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make upstream Hermes sessions the durable chat backend while Hermesdeploy keeps the polished UI and a thin compatibility/migration layer.

**Architecture:** Add an instance/profile-aware upstream session adapter, expose Workspace-style `/sessions`, `/history`, and `send-stream` contracts, and shift the chat UI to treat `sessionKey` as the durable identity. Keep Supabase conversation/message rows as a compatibility mirror for pinned state, last-active state, migration fallback, and the existing durable stream-job runner.

**Tech Stack:** Next.js App Router route handlers, React hooks, Supabase migrations, Jest, TypeScript, SSE over `fetch`

---

## Preconditions

- Work on `main`, per user preference.
- Before any code edit, run and show:

```bash
git status --short
git diff --stat
git diff --name-status
```

- Do not revert existing dirty work unless explicitly instructed. At plan time, the worktree already contains intentional headroom removal/config changes and untracked `.cursor/`.
- After each implementation slice, run:

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

- Commit only the files for that slice with:

```bash
git add <slice files>
git commit -m "feat: chat session contract - <slice summary>"
```

---

## File Map

### Create

- `dashboard/supabase/migrations/20260423143000_add_upstream_chat_session_mapping.sql`
  Adds upstream session mapping and last-active columns to the existing mirror tables.

- `dashboard/src/lib/hermes-chat-gateway.ts`
  Resolves an authenticated, instance/profile-aware gateway context for chat session APIs.

- `dashboard/src/lib/__tests__/hermes-chat-gateway.test.ts`
  Tests default/profile gateway resolution and profile gateway port handling.

- `dashboard/src/lib/hermes-chat-sessions.ts`
  Wraps upstream Hermes session APIs and normalizes sessions/messages into dashboard UI shapes.

- `dashboard/src/lib/__tests__/hermes-chat-sessions.test.ts`
  Tests session list/create/history normalization and upstream payload variants.

- `dashboard/src/lib/chat-session-mirror.ts`
  Owns Supabase mirror upserts, session lookup, last-active tracking, and fallback rows.

- `dashboard/src/lib/__tests__/chat-session-mirror.test.ts`
  Tests mirror upsert/touch/fallback behavior.

- `dashboard/src/app/api/instances/[id]/sessions/route.ts`
  Instance-scoped Workspace-style session list/create/update/delete route.

- `dashboard/src/app/api/instances/[id]/sessions/__tests__/route.test.ts`
  Tests auth, profile scope, upstream success, mirror merge, and fallback.

- `dashboard/src/app/api/instances/[id]/history/route.ts`
  Instance-scoped session history hydration route.

- `dashboard/src/app/api/instances/[id]/history/__tests__/route.test.ts`
  Tests upstream history, active stream fallback, missing session fallback, and last-active touch.

- `dashboard/src/lib/__tests__/server-chat-stream-jobs.test.ts`
  Tests session-key persistence and snapshot mapping for durable stream jobs.

### Modify

- `dashboard/src/components/chat/chat-types.ts`
  Add `sessionKey`, `mirrorConversationId`, `source`, and upstream metadata fields.

- `dashboard/src/components/chat/hooks/chat-engine-state.ts`
  Keep preferred conversation selection working when `id` is the upstream `sessionKey`.

- `dashboard/src/components/chat/hooks/useChatConversations.ts`
  Load/create/select/rename/delete through instance-scoped session routes first.

- `dashboard/src/components/chat/hooks/chat-persistence.ts`
  Route message mirror writes through `mirrorConversationId`, not the upstream `sessionKey`.

- `dashboard/src/components/chat/hooks/useChatStreaming.ts`
  Send both `sessionKey` and `mirrorConversationId`, hydrate snapshots by session key, and keep stream jobs transitional.

- `dashboard/src/components/chat/hooks/chat-stream.ts`
  Capture `sessionKey` from `started` events so direct streams can reconcile backend-created sessions.

- `dashboard/src/components/chat/hooks/__tests__/useChatConversations.test.ts`
  Cover session-list/history hydration and fallback.

- `dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts`
  Cover send payload identity, managed stream snapshot identity, and refresh-safe persistence.

- `dashboard/src/lib/responses-proxy-request.ts`
  Extend `_customDb` to include `sessionKey`, `mirrorConversationId`, provider, and model.

- `dashboard/src/lib/chat-send-stream-events.ts`
  Add optional `sessionKey` and `mirrorConversationId` to normalized events where needed.

- `dashboard/src/lib/chat-send-stream.ts`
  Preserve session identity in `started`, `done`, `error`, and normalized event payloads.

- `dashboard/src/app/api/instances/[id]/send-stream/route.ts`
  Use upstream `sessionKey` as the Sessions transport identity and keep response fallback.

- `dashboard/src/app/api/instances/[id]/send-stream/__tests__/route.test.ts`
  Cover sessionKey preference, backend-created sessions, headers/events, and fallback.

- `dashboard/src/app/api/chat-stream-jobs/route.ts`
  Accept and validate optional `sessionKey` alongside mirror `conversationId`.

- `dashboard/src/lib/server-chat-stream-jobs.ts`
  Persist/read `session_key` in jobs and expose it on snapshots.

- `dashboard/src/lib/chat-stream-jobs-client.ts`
  Send/read `sessionKey` for managed stream snapshots.

- `dashboard/src/app/api/chat-stream-jobs/__tests__/route.test.ts`
  Cover sessionKey acceptance and ownership remaining tied to mirror ids.

---

## Task 1: Add Supabase Mapping Columns

**Files:**
- Create: `dashboard/supabase/migrations/20260423143000_add_upstream_chat_session_mapping.sql`

- [ ] **Step 1: Write the migration**

```sql
alter table public.hermes_conversations
  add column if not exists upstream_session_id text,
  add column if not exists upstream_source text not null default 'supabase',
  add column if not exists last_active_at timestamptz;

alter table public.hermes_messages
  add column if not exists upstream_message_id text;

alter table public.hermes_chat_stream_jobs
  add column if not exists session_key text;

create unique index if not exists hermes_conversations_upstream_session_unique_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, upstream_session_id)
  where upstream_session_id is not null;

create index if not exists hermes_conversations_last_active_idx
  on public.hermes_conversations(user_id, instance_id, profile_name, last_active_at desc)
  where last_active_at is not null;

create index if not exists hermes_messages_upstream_message_idx
  on public.hermes_messages(conversation_id, upstream_message_id)
  where upstream_message_id is not null;

create index if not exists hermes_chat_stream_jobs_session_key_idx
  on public.hermes_chat_stream_jobs(user_id, instance_id, profile_name, session_key, status)
  where session_key is not null;
```

- [ ] **Step 2: Run migration hygiene test**

```bash
cd dashboard
npm test -- --runTestsByPath __tests__/check-supabase-migration-hygiene.test.ts --runInBand --forceExit
```

Expected: PASS.

- [ ] **Step 3: Run full verification**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/supabase/migrations/20260423143000_add_upstream_chat_session_mapping.sql
git commit -m "feat: chat session contract - add upstream session mapping"
```

---

## Task 2: Add Gateway Context Resolver

**Files:**
- Create: `dashboard/src/lib/hermes-chat-gateway.ts`
- Create: `dashboard/src/lib/__tests__/hermes-chat-gateway.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- default profile returns the instance `gateway_url` with no profile gateway port
- non-default profile appends `/profiles/<profile>` and resolves `ProfileService.getProfileGatewayPort`
- unauthorized/missing instance returns a typed error result
- missing gateway URL/API key returns a typed error result

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/hermes-chat-gateway.test.ts --runInBand --forceExit
```

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement resolver**

Public shape:

```ts
export interface HermesChatGatewayContext {
  instanceId: string;
  userId: string;
  profileName: string;
  baseUrl: string;
  apiServerKey: string;
  instanceIpv4?: string;
  profileGatewayPort?: number | null;
  provider?: string | null;
}

export async function resolveHermesChatGatewayContext(input: {
  instanceId: string;
  userId: string;
  profileName?: string | null;
  requireRunning?: boolean;
}): Promise<
  | { ok: true; context: HermesChatGatewayContext }
  | { ok: false; status: number; error: string }
>;
```

Implementation notes:

- Use `getSecureUserInstance`.
- Normalize profile names with existing profile helpers.
- Reuse `ProfileService.getProfileGatewayPort` and `ProfileService.getProfileProvider`.
- Do not perform Codex runtime auth repair here; keep repair in `send-stream` until a later extraction is safe.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/hermes-chat-gateway.test.ts --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add dashboard/src/lib/hermes-chat-gateway.ts dashboard/src/lib/__tests__/hermes-chat-gateway.test.ts
git commit -m "feat: chat session contract - resolve chat gateway context"
```

---

## Task 3: Add Upstream Session Adapter

**Files:**
- Create: `dashboard/src/lib/hermes-chat-sessions.ts`
- Create: `dashboard/src/lib/__tests__/hermes-chat-sessions.test.ts`
- Modify: `dashboard/src/components/chat/chat-types.ts`

- [ ] **Step 1: Extend chat types**

Add optional fields without breaking existing callers:

```ts
export interface MessageData {
  id: string;
  role: MessageRole;
  content: string;
  sessionKey?: string;
  upstreamMessageId?: string;
  // existing fields...
}

export interface ConversationSummary {
  id: string; // upstream sessionKey once new route is active
  title: string;
  pinned: boolean;
  updated_at: string;
  is_temporary?: boolean;
  sessionKey?: string;
  mirrorConversationId?: string;
  source?: "upstream" | "mirror" | "local" | "unavailable";
  preview?: string;
  messageCount?: number;
}
```

- [ ] **Step 2: Write failing adapter tests**

Cover payload variants:

- list response `{ items: [...] }`
- list response `{ sessions: [...] }`
- create response `{ session: {...} }`
- messages response `{ items: [...] }`
- messages response `{ messages: [...] }`
- tool calls as JSON string or array
- timestamp seconds converted to ISO/milliseconds-compatible strings

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/hermes-chat-sessions.test.ts --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 3: Implement adapter**

Public functions:

```ts
export function normalizeHermesSession(raw: unknown): ConversationSummary | null;
export function normalizeHermesMessage(raw: unknown, input: { sessionKey: string; index: number }): MessageData | null;

export function createHermesChatSessionClient(context: HermesChatGatewayContext): {
  listSessions(input?: { limit?: number; offset?: number }): Promise<ConversationSummary[]>;
  createSession(input?: { title?: string; model?: string; id?: string }): Promise<ConversationSummary>;
  updateSession(sessionKey: string, input: { title?: string }): Promise<ConversationSummary>;
  deleteSession(sessionKey: string): Promise<void>;
  getMessages(sessionKey: string, input?: { limit?: number }): Promise<MessageData[]>;
};
```

Implementation notes:

- Use `fetchFirstReachableGatewayResponse`.
- Send `Authorization: Bearer ${context.apiServerKey}` and JSON headers.
- Use root gateway paths first: `/api/sessions`, `/api/sessions/:id`, `/api/sessions/:id/messages`.
- Return typed errors with upstream status text for routes to decide fallback behavior.

- [ ] **Step 4: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/hermes-chat-sessions.test.ts --runInBand --forceExit
```

- [ ] **Step 5: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/components/chat/chat-types.ts \
  dashboard/src/lib/hermes-chat-sessions.ts \
  dashboard/src/lib/__tests__/hermes-chat-sessions.test.ts
git commit -m "feat: chat session contract - add upstream session adapter"
```

---

## Task 4: Add Supabase Mirror Service

**Files:**
- Create: `dashboard/src/lib/chat-session-mirror.ts`
- Create: `dashboard/src/lib/__tests__/chat-session-mirror.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- upserting a mirror row for an upstream session
- preserving encrypted title behavior
- finding a mirror row by upstream session id
- resolving the last active session for user/instance/profile
- falling back to stored conversation rows when upstream is unavailable

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/chat-session-mirror.test.ts --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Implement mirror helpers**

Public functions:

```ts
export async function upsertChatSessionMirror(input: {
  userId: string;
  instanceId: string;
  profileName?: string;
  session: ConversationSummary;
}): Promise<{ mirrorConversationId: string; summary: ConversationSummary }>;

export async function getChatSessionMirror(input: {
  userId: string;
  instanceId: string;
  profileName?: string;
  sessionKey: string;
}): Promise<{ mirrorConversationId: string; summary: ConversationSummary } | null>;

export async function touchChatSessionLastActive(input: {
  userId: string;
  instanceId: string;
  profileName?: string;
  sessionKey: string;
}): Promise<void>;

export async function getLastActiveChatSessionMirror(input: {
  userId: string;
  instanceId: string;
  profileName?: string;
}): Promise<ConversationSummary | null>;
```

Implementation notes:

- Use existing `encryptStoredChatText` and `decryptStoredConversation`.
- Do not save canonical transcript content here.
- Mirror rows should have `upstream_source = 'upstream'` for upstream-backed sessions.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/lib/__tests__/chat-session-mirror.test.ts --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add dashboard/src/lib/chat-session-mirror.ts dashboard/src/lib/__tests__/chat-session-mirror.test.ts
git commit -m "feat: chat session contract - add session mirror service"
```

---

## Task 5: Add Instance Sessions Route

**Files:**
- Create: `dashboard/src/app/api/instances/[id]/sessions/route.ts`
- Create: `dashboard/src/app/api/instances/[id]/sessions/__tests__/route.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- `GET` returns upstream sessions with mirror ids merged in
- `GET` includes `activeSessionKey` from `last_active_at` when available
- `GET` falls back to mirrored Supabase conversations when upstream sessions fail
- `POST` creates upstream session and mirror row
- `PATCH` updates upstream title and mirror title
- `DELETE` deletes upstream session and mirror row
- unauthorized requests return `401`

Run:

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/sessions/__tests__/route.test.ts' --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Implement route**

Response shape:

```ts
type SessionsResponse = {
  success: true;
  data: {
    sessions: ConversationSummary[];
    activeSessionKey: string | null;
    source: "upstream" | "mirror";
  };
};
```

Implementation notes:

- Auth with `auth()` like conversation routes.
- Resolve gateway with `resolveHermesChatGatewayContext`.
- Use `createHermesChatSessionClient`.
- Upsert mirrors for upstream sessions returned by list/create/update.
- Keep `pinned` and `is_temporary` from mirror rows.
- If upstream is unavailable, return mirror sessions with `source: "mirror"` instead of hard failing.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/sessions/__tests__/route.test.ts' --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  'dashboard/src/app/api/instances/[id]/sessions/route.ts' \
  'dashboard/src/app/api/instances/[id]/sessions/__tests__/route.test.ts'
git commit -m "feat: chat session contract - expose instance sessions route"
```

---

## Task 6: Add Instance History Route

**Files:**
- Create: `dashboard/src/app/api/instances/[id]/history/route.ts`
- Create: `dashboard/src/app/api/instances/[id]/history/__tests__/route.test.ts`

- [ ] **Step 1: Write failing route tests**

Cover:

- loads upstream messages for `sessionKey`
- normalizes text, reasoning, tool calls, timestamps, and parent chain
- touches last-active mirror state
- returns mirror messages when upstream is unavailable and a mirror exists
- prefers mirror messages when an active managed stream exists for the mirror conversation
- rejects missing `sessionKey`

Run:

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/history/__tests__/route.test.ts' --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Implement route**

Response shape:

```ts
type HistoryResponse = {
  success: true;
  data: {
    sessionKey: string;
    mirrorConversationId?: string;
    messages: MessageData[];
    source: "upstream" | "mirror";
  };
};
```

Implementation notes:

- Use the upstream adapter first.
- Use `getChatSessionMirror` to identify the mirror row.
- Reuse stored-message fallback logic from `GET /api/conversations/[conversationId]`, but keep it behind the new route.
- Touch `last_active_at` on successful selection/hydration.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/history/__tests__/route.test.ts' --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  'dashboard/src/app/api/instances/[id]/history/route.ts' \
  'dashboard/src/app/api/instances/[id]/history/__tests__/route.test.ts'
git commit -m "feat: chat session contract - expose instance history route"
```

---

## Task 7: Make Send-Stream Session-Key Aware

**Files:**
- Modify: `dashboard/src/lib/responses-proxy-request.ts`
- Modify: `dashboard/src/lib/chat-send-stream-events.ts`
- Modify: `dashboard/src/lib/chat-send-stream.ts`
- Modify: `dashboard/src/app/api/instances/[id]/send-stream/route.ts`
- Modify: `dashboard/src/app/api/instances/[id]/send-stream/__tests__/route.test.ts`

- [ ] **Step 1: Write failing tests**

Add cases for:

- `_customDb.sessionKey` is preferred over `_customDb.conversationId` for `/api/sessions/:sessionKey/chat/stream`
- `conversationId` remains the mirror id for old stream-job compatibility
- `started` event includes `sessionKey` and `mirrorConversationId`
- fallback `/v1/responses` still works when Sessions transport is unavailable
- non-streaming errors remain structured JSON

Run:

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/send-stream/__tests__/route.test.ts' src/lib/__tests__/chat-send-stream-events.test.ts src/lib/__tests__/chat-send-stream.test.ts --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Extend `_customDb` type**

```ts
_customDb?: {
  conversationId?: string;        // mirror Supabase conversation id
  mirrorConversationId?: string;  // explicit mirror id
  sessionKey?: string;            // upstream durable session id
  messageId: string;
  provider?: string;
  model?: string;
}
```

- [ ] **Step 3: Update send-stream route identity**

Session identity resolution:

```ts
const mirrorConversationId = customDb?.mirrorConversationId || customDb?.conversationId;
const sessionKey = customDb?.sessionKey || mirrorConversationId || assistantMessageId;
```

Use `sessionKey` for `/api/sessions/${encodeURIComponent(sessionKey)}/chat/stream`. Keep `mirrorConversationId` in `started` metadata and fallback request data.

- [ ] **Step 4: Preserve session identity in normalized events**

Add optional fields to normalized events:

```ts
sessionKey?: string;
mirrorConversationId?: string;
```

At minimum, `started`, `done`, `error`, and `timeout` should carry them when known.

- [ ] **Step 5: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath 'src/app/api/instances/[id]/send-stream/__tests__/route.test.ts' src/lib/__tests__/chat-send-stream-events.test.ts src/lib/__tests__/chat-send-stream.test.ts --runInBand --forceExit
```

- [ ] **Step 6: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/lib/responses-proxy-request.ts \
  dashboard/src/lib/chat-send-stream-events.ts \
  dashboard/src/lib/chat-send-stream.ts \
  'dashboard/src/app/api/instances/[id]/send-stream/route.ts' \
  'dashboard/src/app/api/instances/[id]/send-stream/__tests__/route.test.ts'
git commit -m "feat: chat session contract - stream by upstream session key"
```

---

## Task 8: Keep Managed Stream Jobs Compatible

**Files:**
- Modify: `dashboard/src/app/api/chat-stream-jobs/route.ts`
- Modify: `dashboard/src/lib/server-chat-stream-jobs.ts`
- Modify: `dashboard/src/lib/chat-stream-jobs-client.ts`
- Modify: `dashboard/src/app/api/chat-stream-jobs/__tests__/route.test.ts`
- Create: `dashboard/src/lib/__tests__/server-chat-stream-jobs.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- `POST /api/chat-stream-jobs` accepts `sessionKey` but still verifies ownership through mirror `conversationId` and `messageId`
- `createServerChatStreamJob` persists `session_key`
- `listServerChatStreamSnapshots` returns `sessionKey`
- client `startServerManagedChatStream` sends `sessionKey`

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/chat-stream-jobs/__tests__/route.test.ts src/lib/__tests__/server-chat-stream-jobs.test.ts --runInBand --forceExit
```

Expected: FAIL until implementation.

- [ ] **Step 2: Implement sessionKey on jobs**

Update params/snapshot types:

```ts
export interface ServerManagedChatStreamSnapshot {
  sessionKey?: string;
  conversationId: string; // mirror id
  // existing fields...
}

export interface CreateServerChatStreamJobParams {
  sessionKey?: string;
  conversationId: string; // mirror id
  // existing fields...
}
```

Use `snapshot.sessionKey || snapshot.conversationId` as the frontend state key.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/app/api/chat-stream-jobs/__tests__/route.test.ts src/lib/__tests__/server-chat-stream-jobs.test.ts --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/app/api/chat-stream-jobs/route.ts \
  dashboard/src/lib/server-chat-stream-jobs.ts \
  dashboard/src/lib/chat-stream-jobs-client.ts \
  dashboard/src/app/api/chat-stream-jobs/__tests__/route.test.ts
git commit -m "feat: chat session contract - keep stream jobs session-aware"
```

---

## Task 9: Move Conversation Hook To Sessions/History

**Files:**
- Modify: `dashboard/src/components/chat/hooks/useChatConversations.ts`
- Modify: `dashboard/src/components/chat/hooks/chat-engine-state.ts`
- Modify: `dashboard/src/components/chat/hooks/__tests__/useChatConversations.test.ts`

- [ ] **Step 1: Write failing hook tests**

Cover:

- `fetchConversations` calls `/api/instances/:id/sessions`
- state conversations use upstream `sessionKey` as `id`
- `activeSessionKey` is selected after fetch when no active conversation exists
- `selectConversation(sessionKey)` calls `/api/instances/:id/history?sessionKey=...`
- `createConversation` returns the upstream `sessionKey` and stores `mirrorConversationId`
- route fallback uses old `/api/conversations` only if the new route fails

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatConversations.test.ts src/__tests__/chat-engine-state.test.ts --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Implement hook changes**

Rules:

- `ConversationSummary.id` becomes the UI key and should equal `sessionKey` for upstream-backed sessions.
- `mirrorConversationId` is only for Supabase compatibility writes/jobs.
- `selectConversation` stores messages under `chatStates[sessionKey]`.
- Keep old route fallback contained and obvious.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatConversations.test.ts src/__tests__/chat-engine-state.test.ts --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/components/chat/hooks/useChatConversations.ts \
  dashboard/src/components/chat/hooks/chat-engine-state.ts \
  dashboard/src/components/chat/hooks/__tests__/useChatConversations.test.ts
git commit -m "feat: chat session contract - hydrate chat from sessions"
```

---

## Task 10: Move Streaming Hook To Session Identity

**Files:**
- Modify: `dashboard/src/components/chat/hooks/chat-persistence.ts`
- Modify: `dashboard/src/components/chat/hooks/chat-stream.ts`
- Modify: `dashboard/src/components/chat/hooks/useChatStreaming.ts`
- Modify: `dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts`

- [ ] **Step 1: Write failing hook tests**

Cover:

- sending on an upstream session includes `_customDb.sessionKey`
- `_customDb.conversationId` / `mirrorConversationId` uses the mirror id
- direct stream `started.sessionKey` can reconcile a backend-created session
- managed stream snapshots update `chatStates[sessionKey]`, not mirror id
- `saveConversationMessage` and `updateConversationMessage` receive the mirror id
- stop/retry/edit keep using the active session key for UI state

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatStreaming.test.ts src/components/chat/hooks/__tests__/chat-stream.test.ts --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Add identity helpers**

Inside `useChatStreaming` or a small helper:

```ts
function getConversationIdentity(activeId: string, conversations: ConversationSummary[]) {
  const summary = conversations.find((conversation) => conversation.id === activeId);
  return {
    sessionKey: summary?.sessionKey || activeId,
    mirrorConversationId: summary?.mirrorConversationId || activeId,
  };
}
```

- [ ] **Step 3: Update send payloads**

Stream and fallback request bodies should include:

```ts
_customDb: {
  sessionKey,
  conversationId: mirrorConversationId,
  mirrorConversationId,
  messageId: assistantMsg.id,
  provider: analyticsProvider,
  model: analyticsModel,
}
```

- [ ] **Step 4: Update managed snapshot application**

Use:

```ts
const stateKey = snapshot.sessionKey || snapshot.conversationId;
```

for `chatStates`, abort refs, and managed stream key maps. Keep `snapshot.conversationId` for server-job stop/delete ownership.

- [ ] **Step 5: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatStreaming.test.ts src/components/chat/hooks/__tests__/chat-stream.test.ts --runInBand --forceExit
```

- [ ] **Step 6: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/components/chat/hooks/chat-persistence.ts \
  dashboard/src/components/chat/hooks/chat-stream.ts \
  dashboard/src/components/chat/hooks/useChatStreaming.ts \
  dashboard/src/components/chat/hooks/__tests__/useChatStreaming.test.ts
git commit -m "feat: chat session contract - send chat with session identity"
```

---

## Task 11: Verify Refresh And Browser Reopen Recovery

**Files:**
- Modify: `dashboard/src/components/chat/hooks/useChatEngine.ts`
- Modify: `dashboard/src/components/chat/hooks/useChatConversations.ts`
- Modify: `dashboard/src/components/chat/__tests__/HermesChat.test.tsx`
- Modify: `dashboard/src/components/chat/hooks/__tests__/useChatConversations.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

- after `fetchConversations` returns `activeSessionKey`, chat auto-selects that session and hydrates history
- if no `activeSessionKey`, newest non-internal upstream session is selected
- if sessions are empty, new-conversation bootstrap still works
- profile changes reset and reload only that profile's sessions

Run:

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatConversations.test.ts src/components/chat/__tests__/HermesChat.test.tsx --runInBand --forceExit
```

Expected: FAIL.

- [ ] **Step 2: Implement reopen behavior**

Rules:

- `GET /sessions` is the source of active session preference.
- `getInitialConversationAction` should continue selecting the preferred conversation from the already-sorted `conversations`.
- Avoid creating a new conversation until session fetch has completed and no sessions exist.
- On profile switch, discard active state from the old profile.

- [ ] **Step 3: Verify focused tests pass**

```bash
cd dashboard
npm test -- --runTestsByPath src/components/chat/hooks/__tests__/useChatConversations.test.ts src/components/chat/__tests__/HermesChat.test.tsx --runInBand --forceExit
```

- [ ] **Step 4: Run full verification and commit**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

```bash
git add \
  dashboard/src/components/chat/hooks/useChatEngine.ts \
  dashboard/src/components/chat/hooks/useChatConversations.ts \
  dashboard/src/components/chat/__tests__/HermesChat.test.tsx \
  dashboard/src/components/chat/hooks/__tests__/useChatConversations.test.ts
git commit -m "feat: chat session contract - restore active sessions on reload"
```

---

## Task 12: Final Hardening Pass

**Files:**
- Modify tests touched above as needed
- Modify docs if implementation deviates from this plan

- [ ] **Step 1: Run focused chat route/hook tests**

```bash
cd dashboard
npm test -- --runTestsByPath \
  src/lib/__tests__/hermes-chat-gateway.test.ts \
  src/lib/__tests__/hermes-chat-sessions.test.ts \
  src/lib/__tests__/chat-session-mirror.test.ts \
  'src/app/api/instances/[id]/sessions/__tests__/route.test.ts' \
  'src/app/api/instances/[id]/history/__tests__/route.test.ts' \
  'src/app/api/instances/[id]/send-stream/__tests__/route.test.ts' \
  src/app/api/chat-stream-jobs/__tests__/route.test.ts \
  src/components/chat/hooks/__tests__/useChatConversations.test.ts \
  src/components/chat/hooks/__tests__/useChatStreaming.test.ts \
  src/components/chat/__tests__/HermesChat.test.tsx \
  --runInBand --forceExit
```

- [ ] **Step 2: Run full verification**

```bash
cd dashboard
npm run lint
npm run typecheck
npm run test:ci
npm run build
```

- [ ] **Step 3: Review final diff**

```bash
git status --short
git diff --stat
git diff --name-status
```

Confirm only planned files are changed.

- [ ] **Step 4: Commit final docs/test adjustments if any**

```bash
git add <final adjustment files>
git commit -m "feat: chat session contract - harden refresh recovery"
```

---

## Potential Regressions To Watch

- Existing Supabase conversation ids are UUIDs, while upstream session ids may be arbitrary strings.
- Managed stream jobs still require mirror UUID rows and message UUID rows.
- Branch/edit/retry may rely on local `parent_id` chains that upstream history cannot perfectly represent yet.
- Stop/cancel must target stream jobs by mirror/job ids while UI state is keyed by upstream session id.
- Profile switching can leak sessions if profile name normalization differs between routes and hooks.
- Pinned/temp conversations are local UI metadata and must not disappear when upstream sessions are listed.
- Existing `/api/conversations` routes must remain usable as fallback during migration.

---

## Approval Gate

Do not start Task 1 until the user replies `APPROVED` to this implementation plan.
