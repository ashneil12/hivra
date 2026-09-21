# Chat Refactor Benchmark After

Date: 2026-05-03
Worktree: `codex/chat-refactor-one-truth`

## What changed

The dashboard chat path now has one chat-content truth for WebUI instances:

- Sessions and history come from WebUI/agent session data.
- Postgres chat tables are metadata/deprecated rollback surfaces, not message truth.
- IndexedDB is a cosmetic display cache; live agent data overwrites it.
- Sending a WebUI chat calls `POST /api/instances/{id}/chat-start`, then opens the signed `EventSource` URL directly to the VM.
- The public `/api/chat-stream-jobs` polling route/client is deleted.
- The browser Service Worker no longer owns chat streaming.
- The Node sidecar no longer ships mirror-sync code or dashboard mirror-sync endpoints.

## Request shape after refactor

| User action | Blocking requests after refactor | Removed from the active WebUI path |
|---|---|---|
| Cold chat load | `GET /api/instances/{id}/sessions?profileName=...&source=upstream` | Postgres chat-content reads and ghost mirror rows |
| Select chat | `GET /api/instances/{id}/history?sessionKey=...&profileName=...&source=upstream` plus approval check | Postgres message mirror reads |
| Send message | `POST /api/instances/{id}/chat-start`, then browser-direct `EventSource` to the signed VM URL | Vercel long-lived SSE proxy, `/api/chat-stream-jobs` polling, browser Service Worker stream transport, dashboard message persistence |

## Verification

Code-level verification completed:

- `src/components/chat/hooks/__tests__/useChatStreaming.test.ts`
- `src/components/chat/hooks/__tests__/useChatConversations.test.ts`
- `src/components/chat/hooks/__tests__/chat-local-cache.test.ts`
- `src/lib/__tests__/chat-stream-instance-worker-script.test.ts`
- `src/__tests__/chat-refactor-phase5-cleanup.test.ts`
- migration guard tests for mirror demotion
- full `npm run verify` before Phase 4 push

Live browser timing still needs a refreshed provider token and logged-in browser session to certify:

- `/dashboard/chat` navigation to sessions visible
- click chat to first message visible
- send to first token visible
- 5-10 minute stream completion

The pre-flight stream test already verified the signed URL, Caddy `forward_auth`, and direct SSE route. The only blocker was provider credential failure (`auth_mismatch / token_invalidated`), not the stream architecture.
