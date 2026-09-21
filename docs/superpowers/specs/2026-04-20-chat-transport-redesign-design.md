# Hermesdeploy Chat Transport Redesign

**Date:** 2026-04-20  
**Status:** Approved and started  
**Scope:** Dashboard chat transport, streaming contract, and persistence boundaries

---

## Goal

Move Hermesdeploy chat onto a long-term stable shape where:

1. the server owns upstream streaming quirks
2. the frontend consumes one normalized stream contract
3. persistence stays separate from transport parsing

The intended result is that future chat work becomes isolated maintenance instead of repeated whole-pipeline firefighting.

---

## Comparison Snapshot

### Hermesdeploy before this redesign

The old dashboard path concentrated too much responsibility into:

- `dashboard/src/components/chat/hooks/useChatStreaming.ts`
- a legacy Pages Router `/responses` API endpoint that has since been retired

That meant the frontend knew about:

- upstream payload shaping
- mixed SSE dialects
- fallback behavior
- partial persistence timing

### hermes-workspace shape

hermes-workspace uses a healthier split:

- dedicated transport route
- client send entrypoint
- client stream consumer
- backend capability selection outside the chat UI

The important architectural lesson is not "copy their whole app." It is:

- one authoritative send/stream route
- one normalized event vocabulary
- one thinner frontend consumer

### Decision

Hermesdeploy should adopt the workspace **architecture shape** without transplanting workspace-only product complexity.

That means:

- keep Hermesdeploy conversation persistence and branch model
- copy the cleaner transport boundaries
- stop letting raw upstream event formats leak into the UI

---

## Target Architecture

### Transport

Introduce an instance-scoped send/stream route:

- `dashboard/src/app/api/instances/[id]/send-stream/route.ts`

Responsibilities:

- validate send requests
- call the upstream Hermes gateway
- normalize upstream SSE and JSON responses
- emit Hermesdeploy-native SSE events

### Stream contract

The frontend should only see this vocabulary:

- `started`
- `message`
- `chunk`
- `thinking`
- `tool`
- `done`
- `error`
- `timeout`
- `close`

### Frontend

The frontend should keep:

- optimistic user and assistant placeholder insertion
- visible chat-state updates
- final persistence updates

The frontend should lose:

- backend-specific event parsing branches
- direct coupling to raw Responses/session SSE semantics

### Persistence

Supabase remains the source of truth for stored conversations and assistant messages.

Persistence is responsible for:

- saving the user turn
- reserving the assistant turn when needed
- patching final content, tool calls, artifacts, and analytics metadata

Persistence is not responsible for understanding upstream transport formats.

---

## Migration Strategy

1. Build the normalized send/stream route beside the old path.
2. Teach the existing frontend parser to consume the normalized contract.
3. Move the main hook onto the new route.
4. Reduce the legacy `/responses` route after parity is confirmed.
5. Add lifecycle and interruption hardening once the new path is authoritative.

---

## Implemented First Slice

This redesign has started with:

- `dashboard/src/lib/chat-send-stream-events.ts`
- `dashboard/src/lib/chat-send-stream.ts`
- `dashboard/src/app/api/instances/[id]/send-stream/route.ts`
- `dashboard/src/components/chat/hooks/chat-stream.ts`
- `dashboard/src/components/chat/hooks/useChatStreaming.ts`

Current effect:

- the dashboard can send through the new `send-stream` route
- the hook can consume normalized `chunk` and `done` events
- sparse completed-only streams are upgraded into usable assistant output

---

## Success Criteria

This redesign is successful when:

- the dashboard frontend depends on one normalized transport contract
- sparse or single-shot upstream replies still render correctly
- tool-heavy and long-running streams can be handled without blank assistant messages
- persistence fixes do not require stream-parser rewrites
- chat changes mostly happen in one layer at a time
