# Logging Spec — Vercel-First Observability

**Status:** Draft for review
**Owner:** Ash
**Date:** 2026-04-29
**Scope:** `dashboard/` (Next.js 16 App Router on Vercel)

---

## 1. Goal

When something breaks in production, opening Vercel Logs should be enough to diagnose it — no re-running the request, no re-deploying with extra `console.log`s, no guessing at user state.

Concretely, every error log entry in Vercel must answer:

1. **Who** — userId (Clerk) or "anonymous"
2. **Where** — route, source module, request ID
3. **What** — error message, error class, stack
4. **With what** — sanitized inputs, relevant entity IDs (instanceId, conversationId, etc.)
5. **Outcome** — HTTP status, whether retried, whether reported to ops_events

---

## 2. Why this is "consolidate" not "build"

The codebase already has the right primitives. They're just not unified:

| Primitive | Status | File |
|---|---|---|
| Sanitization (token/secret redaction) | ✅ Exists | `dashboard/src/lib/ops-events.ts` |
| Server ops events → Supabase `ops_events` | ✅ Exists | `dashboard/src/lib/ops-events.ts` |
| Client ops events → `/api/ops/events` | ✅ Exists | `dashboard/src/lib/client/ops-events.ts` |
| Global frontend error capture | ✅ Exists | `dashboard/src/app/providers/OpsTelemetryProvider.tsx` |
| Error boundary | ✅ Exists | `dashboard/src/app/dashboard/error.tsx` |
| Standardized API error shape | ✅ Exists | `dashboard/src/lib/api-response.ts` |
| Clerk userId in API routes | ✅ Available | via `await auth()` |
| **Unified logger module** | ❌ Missing | — |
| **Request ID propagation** | ❌ Missing | — |
| **Replacement of bare `console.*`** | ❌ ~246 calls scattered | — |
| **Next.js instrumentation hook** | ❌ Missing | `dashboard/instrumentation.ts` |

So the work is: build the missing logger, route all existing `console.*` and ops_events calls through it, and propagate a request ID.

---

## 3. Design

### 3.1 The logger module — `dashboard/src/lib/logger.ts`

A single, tiny module. No new dependencies (no pino/winston). It wraps `console.*` so output still lands in Vercel Logs, and optionally fires `reportOpsEvent` for severity ≥ error.

```ts
// shape (illustrative — final API decided in implementation)
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  requestId?: string;
  userId?: string | null;
  route?: string;
  source: string;          // module name, required
  instanceId?: string | null;
  conversationId?: string | null;
  [key: string]: unknown;  // arbitrary structured fields
}

const log = {
  debug(msg: string, ctx?: Partial<LogContext>): void
  info(msg: string, ctx?: Partial<LogContext>): void
  warn(msg: string, ctx?: Partial<LogContext>): void
  error(msg: string, err: unknown, ctx?: Partial<LogContext>): void
}
```

**Output format (single line, JSON):**

```json
{"ts":"2026-04-29T14:22:01.123Z","level":"error","source":"hetzner-instance-service","requestId":"req_abc123","userId":"user_xyz","route":"POST /api/instances","msg":"Hetzner provision failed","err":{"name":"Error","message":"...","stack":"..."},"instanceId":"inst_01","failureType":"network_timeout"}
```

Vercel Logs displays this as a structured row when JSON; the `msg` field is what you scan visually. `requestId` is the join key across multiple log lines for the same request.

**Behavior by level:**
- `debug`: stdout only, suppressed in production by default
- `info` / `warn`: stdout
- `error`: stdout + `reportOpsEvent` (existing path) — preserves the audit trail in Supabase

**Sanitization:** logger calls `sanitizeOpsMetadata` on the context object before serializing. No new redaction logic.

### 3.2 Request ID propagation

Two pieces:

1. **Middleware** (`dashboard/middleware.ts`, may need to create or extend) — read `x-vercel-id` if present (Vercel sets this automatically) or generate `req_${nanoid(8)}`, set it on a request header so handlers can read it.
2. **Per-route helper** — `getRequestContext(req)` returns `{ requestId, userId, route }` ready to spread into log calls.

API route shape becomes:

```ts
export async function POST(req: NextRequest) {
  const ctx = await getRequestContext(req); // { requestId, userId, route }
  log.info("instance create requested", { ...ctx, source: "instances" });
  try {
    // ...
  } catch (err) {
    log.error("instance create failed", err, { ...ctx, source: "instances", instanceId });
    return apiError(...);
  }
}
```

`apiError` is updated to accept the `ctx` object and use it instead of the current scattered options.

### 3.3 Frontend logger — `dashboard/src/lib/client/logger.ts`

Mirror of the server logger, but:
- Posts errors to `/api/ops/events` (existing endpoint)
- Tags with `source: "client"`, current route, Clerk userId from session
- Includes browser metadata (already collected in `OpsTelemetryProvider`)

`OpsTelemetryProvider` is refactored to call this logger instead of inline `captureClientOpsEvent` calls — same wire format, but now component code uses `clientLog.error("foo failed", err)` instead of bespoke calls.

### 3.4 Next.js instrumentation hook — `dashboard/instrumentation.ts`

A minimal `register()` that runs once on server start. Initial use:
- Log app version + git SHA at boot (so Vercel Logs shows which deployment is running)
- Wire `process.on("unhandledRejection")` and `process.on("uncaughtException")` to the logger

We do **not** add OpenTelemetry / distributed tracing in this pass. That's a future call once the basics are in place.

### 3.5 Migration of existing `console.*`

Roughly ~246 calls. We migrate **opportunistically**, not in one big sweep:

- **Wave 1 (this spec):** API route handlers under `dashboard/src/app/api/**` (~83 calls). These are highest-value because each is tied to a request and a user.
- **Wave 2 (follow-up):** Service layer (`hetzner-instance-service.ts`, `proxmox*.ts`, billing services). High-value because these are the integration boundaries.
- **Wave 3 (follow-up):** Everything else, as we touch each file naturally.

Add an ESLint rule (`no-console`) with override comments allowed only in the logger module itself, so new `console.*` calls are caught at PR time. Existing calls suppressed via per-file disable comments during migration so the rule lands on day one without a 246-call diff.

---

## 4. Out of scope (keep this small)

The following are explicitly **not** in this spec — flag them only if they become blockers:

- ❌ OpenTelemetry / distributed tracing
- ❌ Datadog / Axiom / Logflare / external log aggregator (Vercel Logs only)
- ❌ Log retention policy changes (Vercel default)
- ❌ Metrics / dashboards (separate concern)
- ❌ Frontend session replay (PostHog already does this)
- ❌ Migrating all 246 console calls in a single PR
- ❌ Changing the existing `ops_events` table schema

If any of these come up during implementation, stop and surface the question rather than expanding scope.

---

## 5. Implementation plan

Three PRs, each independently shippable and reviewable.

### PR 1 — Logger module + request ID + instrumentation

**Files added:**
- `dashboard/src/lib/logger.ts` (server)
- `dashboard/src/lib/client/logger.ts` (client)
- `dashboard/src/lib/request-context.ts` (getRequestContext helper)
- `dashboard/instrumentation.ts`

**Files modified:**
- `dashboard/middleware.ts` — request ID generation
- `dashboard/src/lib/api-response.ts` — accept `ctx`, call logger
- `dashboard/.eslintrc` — add `no-console` rule + ignore for logger files

**No behavioral change to existing routes.** This PR just lands the infrastructure. Existing `console.*` calls still work; new code can opt in.

**Acceptance:**
- A log line from any API route includes `requestId`, `userId`, `route`, `source`
- Vercel Logs shows the JSON structured (verified by deploying to a preview)
- `npm run typecheck` and `npm run lint` pass

### PR 2 — Migrate API routes (Wave 1)

Replace `console.*` in `dashboard/src/app/api/**` with logger calls. Update `apiError` callers to pass `ctx`.

**Acceptance:**
- 0 `console.*` calls remain in `dashboard/src/app/api/**` (verified by grep)
- An induced 500 from any route produces a log line with full context
- ops_events table receives the same events it does today (no regression in audit trail)

### PR 3 — Frontend logger + OpsTelemetryProvider refactor

Refactor `OpsTelemetryProvider` and `dashboard/src/app/dashboard/error.tsx` to use `clientLog`. Update PostHog integration to read from the logger instead of being called directly.

**Acceptance:**
- Throwing in a component produces an entry in `ops_events` with route, userId, requestId-of-fetch (where applicable), and lands in Vercel Logs via `/api/ops/events` server log
- PostHog still receives the same exceptions (no regression)

---

## 6. Acceptance criteria (whole effort)

The logging effort is "done" when all of the following hold:

1. ✅ I can open Vercel Logs, filter by a userId, and see every log line for that user across a session
2. ✅ I can grep Vercel Logs for a `requestId` and see the full server-side trace for one request
3. ✅ A 500 from production includes the error class, message, stack, route, userId, and relevant entity IDs in a single log line
4. ✅ A frontend error in a user's browser ends up in Vercel Logs (via `/api/ops/events`) with route + userId + browser metadata
5. ✅ New `console.*` calls in PRs are blocked by lint
6. ✅ No existing functionality regressed (ops_events table still populated, PostHog still capturing, Clerk auth unaffected)

---

## 7. Open questions for Ash

Before I start PR 1, I need decisions on:

1. **Log volume tolerance** — Vercel charges by log volume on paid plans. `info` logs on every API hit could be noisy. Default proposal: `info` enabled in production, `debug` suppressed. OK?
2. **Sampling** — should we sample `info` logs (e.g. 1 in 10) to keep volume down? Default proposal: no sampling for v1, revisit if volume becomes a cost issue.
3. **Wave 1 scope** — am I right that "API routes" means `dashboard/src/app/api/**` only, or do you want me to include the server actions / route handlers under `dashboard/src/app/dashboard/**` that hit Supabase directly?
4. **Request ID format** — prefer `req_${nanoid(8)}` or use Vercel's `x-vercel-id` directly? (Vercel's is longer but already correlates with their infra.) Default proposal: prefer `x-vercel-id` when present, generate `req_*` as fallback.
5. **Backend → frontend correlation** — should API responses include the `requestId` in a header (`x-request-id`) so frontend logs can reference it? Cheap to add now, hard to retrofit. Default proposal: yes, add the header.

---

## 8. What this unlocks for testing (preview of next workstream)

Once logging lands, the testing workstream gets cheaper:
- Integration tests can assert on log lines (much more reliable than asserting on response bodies)
- E2E test failures in CI become debuggable from logs alone
- Third-party API breakage shows up as a recognizable log pattern, not an opaque test failure

So testing is the natural next layer on top of this.
