# Chat durability — VM-resident sidecar runner (plan)

Status: **foundation built, integration pending.** The sidecar service
(read-only JSONL → cursor-resumable SSE) and the producer-side tee in
`streaming.py` are in `hermes-webui` (uncommitted at writing). Open
questions below are resolved. Remaining work is compose/Caddy/dashboard/SW
wiring on this Hermesdeploy side.

Companion to the pending-approval recovery already shipped in `719c5209`
(commit `feat(chat): pending-approval recovery on conversation load`).

## Resolved architecture (after first build pass)

- **Topology:** `hermes-webui` owns the **write** to JSONL; the sidecar
  owns the **read**. The `put()` closure in
  [`api/streaming.py`](../../hermes-webui/api/streaming.py) tees every
  emitted SSE event into `<chat_jobs_dir>/<stream_id>.jsonl` immediately
  after the in-memory queue push. The sidecar process is read-only —
  it knows nothing about the chat lifecycle and never writes. This is a
  hybrid of the two options the original plan listed: not a full proxy
  in front of webui, not a same-process extension. The JSONL on disk
  is the contract between them, which is why the sidecar can be
  restarted independently without losing events the agent is mid-emitting.
- **Event log format:** JSONL, append-only, one event per line. Each
  line is `{"seq": int, "event": str, "data": dict, "ts": float}`.
  Cursor = byte offset of next byte to read. O(1) seek, no schema
  migrations to worry about.
- **Cursor protocol:** SSE `id:` field on each frame is the
  `cursor_after` value. Browser tracks the last `id` it received and
  reconnects with `?cursor=<id>`. EventSource's built-in
  `Last-Event-Id` header carries the same value, so the SW can rely on
  either path.
- **Terminator events:** `done`, `error`, `cancel`, `timeout`, `close`,
  `stream_end`. Sidecar's tail loop stops on any of these. Idle-timeout
  fallback (300s default) handles agent crashes that never wrote a
  terminator.
- **Stream ID safety:** sidecar validates against
  `^[A-Za-z0-9_\-]{1,128}$` before opening any file; rejects path
  traversal at the HTTP layer.
- **TTL/cleanup:** deferred. Defaults to never-prune in this first
  build. A future sweep can prune by reading the agent session index
  and deleting any `<chat_jobs_dir>/<stream_id>.jsonl` whose stream is
  no longer present.
- **Backfill:** new chats only. Existing chats keep using the legacy
  `send-stream` proxy until the SW probe sees the sidecar is reachable
  for that instance.

## What's already built (in `hermes-webui`)

| Path | What it does |
|---|---|
| `sidecar/log_reader.py` | Pure JSONL read+tail logic. Cursor protocol, frame parsing, SSE encoding, `append_event_atomic()` writer used by the tee. ~250 lines, stdlib-only. |
| `sidecar/server.py` | `ThreadingHTTPServer` + `BaseHTTPRequestHandler`. Routes `GET /chat-jobs/health` and `GET /chat-jobs/<id>/events?cursor=<n>`. |
| `sidecar/__main__.py` | `python -m sidecar` entry point. |
| `sidecar/tests/test_log_reader.py` | 30 unit tests pinning cursor semantics, terminator handling, malformed-line skip behavior, concurrent-append atomicity, encoding format. |
| `sidecar/tests/test_server.py` | 12 HTTP integration tests covering health, error responses (400/404/416), full replay, mid-cursor resume, mid-tail appends, resume-then-tail. |
| `sidecar/tests/test_streaming_tee.py` | 3 tests ensuring the tee writes the format the reader expects, with isolated per-stream files, and propagates input-validation errors instead of swallowing them. |
| `api/config.py` | Adds `CHAT_JOBS_DIR` (env-overridable via `HERMES_CHAT_JOBS_DIR`, defaults to `<STATE_DIR>/chat-jobs`). |
| `api/streaming.py` | Tee inside the inner `put()` closure: every event also gets `append_event_atomic(CHAT_JOBS_DIR, stream_id, event, data, seq=...)`. Best-effort — disk failure logs at debug and continues. |

All 46 sidecar tests pass under Python 3.9 (test runner) and the
streaming.py imports clean under Python 3.12 (deployment runtime).

## What's NOT yet built (next slices, in this Hermesdeploy repo)

1. Compose: add the sidecar as a sibling container in
   `dashboard/src/lib/services/webui-instance-builder.ts`, exposing
   port 8788 internally.
2. Caddy: in
   `dashboard/src/lib/services/proxmox-instance-service.ts`, add a
   second matcher (or extend `@signedSseStream`) to route
   `/api/chat-jobs/*` to the sidecar's port instead of the webui's
   port 80. Forward-auth stays the same.
3. Dashboard: change the URL minted by
   `/api/instances/[id]/chat-start` to point at
   `/api/chat-jobs/<stream_id>/events?cursor=0` once the sidecar is
   reachable. Probe with `GET /chat-jobs/health` over the signed-URL
   path; fall back to the legacy `/api/chat/stream` if probe fails.
4. SW: track `state.lastEventCursor` in `dashboard/public/sw.js` and
   `dashboard/src/lib/chat-stream-service-worker.ts`. Persist to
   IndexedDB. On reconnect, re-issue with `?cursor=<n>`.
5. Re-enable `/api/chat-stream-jobs` for WebUI agents (drop the 503
   short-circuit) once the durability path is proven.

## Why

After today's chat fixes, the system survives Vercel timeouts and tab-close
*for the message-persistence path*: the agent keeps generating, persists messages
to its session file, and on refresh the dashboard reloads them. What it doesn't
survive:

- **Live token streaming after reconnect.** A user who closes the tab while a
  long reply is mid-stream sees only the final saved state on refresh, not a
  resumed stream.
- **Mid-stream tool result replay.** If the agent runs three tools in sequence
  and the user closes the tab between tool 2 and tool 3, the recovery path
  shows the persisted state at refresh time, not the intermediate tool calls
  the user already saw.
- **Approval-respond → completion lag.** Today's recovery card lets the user
  unblock the agent on reconnect, but the user has to manually refresh to see
  the post-Allow output. The dashboard isn't subscribed to live events.
- **Vercel function lifecycle bound to the streaming path.** Even with
  `maxDuration = 300`, the SSE proxy ties the user's connection to a specific
  lambda. A redeploy mid-stream cuts the connection.

The sidecar runner closes all four. It's also the architectural answer to the
"server-managed chat stream is disabled for WebUI agents" 503 short-circuit in
`/api/chat-stream-jobs` — that runner is functionally what this plan generalises.

## Architecture

```
┌────────────────────┐         ┌─────────────────────────────────────┐
│   Browser (SW)     │  SSE    │   Agent VM                          │
│                    │ ──────► │                                     │
│                    │         │  ┌──────────────┐   ┌────────────┐  │
│                    │         │  │  Sidecar     │   │ hermes-    │  │
│  Reconnect: ?cursor│ ◄────── │  │  (chat-jobs) │ ─►│ webui      │  │
│                    │         │  │              │   │ (existing) │  │
│                    │         │  │  - state.db  │   │            │  │
│                    │         │  │  - replay    │   └────────────┘  │
│                    │         │  └──────────────┘                   │
└────────────────────┘         └─────────────────────────────────────┘
```

### Components

**Sidecar service** — small Python or Node service running in the agent VM,
sibling container to hermes-webui. Owns:

- The chat job lifecycle (start, stream, cancel, query state)
- A SQLite database (or compacted JSONL log, TBD) at
  `~/.hermes/chat-jobs/<job-id>.db` containing every emitted SSE event in order
- An SSE endpoint that replays from a cursor position and streams new events
  as they arrive. URL shape: `GET /chat-jobs/:id/events?cursor=<offset>`
- A control endpoint to start jobs, send approval responses, cancel
- A health endpoint (existing pattern from chat-stream-worker)

**Browser-side reconnect protocol** — SW remembers the last consumed cursor
per `streamKey`. On `fetch(state.proxyUrl, ...)` failure or tab focus, the SW
re-issues the SSE GET with the saved cursor. The sidecar streams the missed
events first, then continues live. Same model as Postgres logical replication.

**Outer Caddy auth** — reuse the signed-URL forward_auth pattern already built
on `feat/direct-stream-wiring` (HMAC token, sig+exp+stream_id query params,
`/api/internal/agent-stream-auth` validates with the dashboard). The sidecar
endpoint is gated by the same signed URL pattern; nothing changes about how
the dashboard mints tokens.

**Dashboard chat-start route** — `/api/instances/[id]/chat-start` already
mints the signed URL. It moves from pointing at the agent's
`/api/chat/stream` to pointing at the sidecar's `/chat-jobs/:id/events`.
That's a one-line config change once the sidecar is deployed.

## What's reusable from today's work

- **HMAC token + signed URL** (commits `55fcbc8e`, `b02f3fe6`): mints
  per-stream signed URLs scoped to `instance_id`. Drop-in for sidecar gating.
- **Outer Caddy `@signedSseStream` matcher** (commit `a81a781b` after the
  AND fix): the routing block already exists — change the upstream from
  `10.250.20.50:80` to the sidecar's port.
- **`/api/internal/agent-stream-auth` forward_auth** (commit `8511f8fa`):
  validates the signed URL on every connect. No changes needed.
- **Service-Worker upsert plumbing** (commit `417b5da7`): the SW already
  knows how to consume SSE, normalize tool events, persist messages. The
  reconnect-with-cursor path is a small additive change to `consumeManagedChatStream`.
- **chat-stream-jobs runner** (existing on Hermesdeploy main, currently
  short-circuited 503 for WebUI agents): the lease/heartbeat/zombie-reclaim
  bookkeeping is essentially what the sidecar needs at a higher level.
  Code is reusable as a reference even if the sidecar is its own service.

## What's new work

| Component | Effort | Notes |
|---|---|---|
| Sidecar service skeleton (Dockerfile, compose entry, healthcheck) | 0.5 day | Mirror hermes-webui container layout |
| SSE event log persistence (SQLite or JSONL) | 1 day | Append-only, cursor = byte offset or row id |
| Cursor-resumable SSE endpoint | 1 day | Reads-then-streams pattern; handle "cursor past tail" gracefully |
| Job lifecycle state machine (queued → streaming → done/error/stopped) | 0.5 day | Mirrors chat-stream-jobs schema |
| Browser-side cursor tracking in SW | 0.5 day | `state.lastEventCursor`, persist to IndexedDB before tab close |
| Reconnect path in `consumeManagedChatStream` | 1 day | On error/connect, re-fetch with cursor; stitch event stream seamlessly |
| Compose / provisioning changes (add sidecar to instance.yml + Caddy upstream) | 0.5 day | webui-instance-builder.ts |
| Migration for existing instances (rolling restart with sidecar) | 0.5 day | Pull new image, recreate; no data migration |
| Tests (sidecar unit + Hermesdeploy integration) | 1.5 days | The wire format is the contract; pin it tight |
| Re-enable `/api/chat-stream-jobs` for WebUI agents now that durability holds | 0.5 day | Drop the `webui_managed_stream_disabled` short-circuit |
| **Total** | **~7 working days** | Single focused stretch |

## Failure modes covered

| Failure | Today | After sidecar |
|---|---|---|
| Tab close mid-stream | Reply lands eventually, no resume | Reconnect picks up at last cursor, live tail continues |
| Vercel function timeout | Reply lands eventually, stream dies | Vercel never in the streaming path |
| Vercel deploy mid-chat | Stream dies | Streaming is browser ↔ Caddy ↔ sidecar; Vercel only mints the URL |
| Agent container restart mid-chat | Stream + state lost | Sidecar persists events to disk; on agent restart, sidecar replays buffered events to reconnects (the agent thread itself is gone, so the run is "stopped" terminal state, but the user sees up to that point) |
| Sidecar restart mid-chat | n/a | Brief window where new connections fail; existing connections drop; same as agent restart at sidecar level. Could mitigate with two replicas + shared state if it matters |
| VM crash | Total loss | Same — VM-resident architecture can't survive its own VM dying |

## Open questions — resolved during the first build

1. **SQLite vs JSONL** → **JSONL.** Append-only, byte-offset cursor,
   stdlib-only (no extra dep on top of pyyaml). Concurrent-append
   atomicity was verified under load (`test_concurrent_appends_dont_corrupt`).
2. **Sidecar topology** → **sibling container, but read-only.** The
   `hermes-webui` process owns the write side via the tee in `put()`;
   the sidecar process owns the read side. JSONL on a shared volume is
   the contract.
3. **Cursor format** → **byte offset.** Sent as the SSE `id:` field on
   every frame; client echoes back via `?cursor=<n>` or
   `Last-Event-Id`.
4. **Clarify cards** → handled implicitly. The sidecar is event-blind;
   it persists whatever `streaming.py` emits. `approval`, `clarify`,
   and any future "agent-paused" surface ride the same path.
5. **TTL** → **deferred.** First build never prunes. Sweep job can be
   added later by reading the session index.
6. **Backfill** → **new chats only.** Old chats stay on the legacy
   send-stream proxy.

## Migration / rollout

1. Build sidecar in its own repo or as `hermes-webui/sidecar/` subdir; ship
   alongside the agent image.
2. Provision new instances with the sidecar enabled by default; existing
   instances keep working through the dashboard's send-stream proxy until
   they're recreated.
3. When stable, flip the dashboard's `chat-start` URL to point at the sidecar
   for any instance that has it. Detect via a feature probe at
   `GET /chat-jobs/health` on the sidecar port; fall back to the legacy
   send-stream path if probe fails.
4. After 1-2 weeks of dual-path stability, remove the legacy
   `/api/instances/[id]/send-stream` proxy and the SW's fetch-of-Vercel path
   entirely. The WebUI 503 short-circuit in `/api/chat-stream-jobs` also goes.

## Out of scope

- Multi-region failover. Sidecar is per-VM, not cross-VM.
- Real-time multi-tab sync (two browsers viewing the same chat watching the
  same stream). Achievable as a follow-up — sidecar could fan out to multiple
  cursor consumers from the same job — but solves a problem nobody has
  reported.
- Agent thread persistence across container restarts. The thread itself is
  gone; the sidecar only persists what the thread emitted before it died.

## Linked issues / commits

- `feat/direct-stream-wiring` branch (signed URL infrastructure, currently
  half-built on the browser side; lands as foundation for sidecar gating)
- `b02f3fe6` — `chat-start` endpoint that mints signed direct-SSE URLs
- `8511f8fa` — `/api/internal/agent-stream-auth` forward_auth handler
- `a974e597` — outer Caddy generator emits forward_auth + CORS site
- `1778b46b` — `/api/chat-stream-jobs` 503 short-circuit for WebUI agents
  (the symptom this plan removes)
- `719c5209` — pending-approval recovery (landed today; covers the
  approval-flow durability case until sidecar lands)
