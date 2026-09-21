import posthog from 'posthog-js'

// Init-safe wrappers around the posthog-js client.
//
// PostHogProvider defers `posthog.init()` via requestIdleCallback (up to 2s,
// with a setTimeout fallback) to keep PostHog off the LCP critical path. Any
// `posthog.capture()` / `posthog.identify()` that runs during that window hits
// an uninitialized client — in the browser that can throw, and the throw
// bubbles to OpsTelemetryProvider's window.onerror handler, which re-captures
// it as a `$exception` (canary #129: "21x `Error`: PostHog API called before
// deferred init completes").
//
// These wrappers queue early calls and flush them in order once init completes,
// and never throw. After init they pass straight through. Callers that may fire
// before init (e.g. the pageview/identify effects in PostHogProvider) should go
// through here instead of touching the posthog singleton directly.

type QueuedCall =
  | { kind: 'capture'; event: string; properties?: Record<string, unknown> }
  | { kind: 'identify_user'; distinctId: string; properties?: Record<string, unknown> }
  | { kind: 'reset_if_identified' }

// Bounded so a session where init never completes (recorder script blocked, bad
// proxy) can't grow the queue without limit. Past the cap the oldest call is
// dropped — acceptable for best-effort analytics, and "safely dropped without
// throwing" satisfies the reliability contract.
const MAX_QUEUED_CALLS = 50

const queue: QueuedCall[] = []
let flushed = false

// Set once, at module load, when no PostHog project token is configured (see
// PostHogProvider). Without it every captureClient() call site in the app would
// enqueue into a buffer that is never drained, because init() — the only thing
// that calls flushPostHogQueue() — never runs. "Analytics off" has to mean a
// no-op, not a ring buffer quietly cycling 50 events for the life of the tab.
let disabled = false

// posthog-js sets `__loaded = true` synchronously inside init(); treat that as
// ready too in case some path initializes posthog without calling flush.
function isLoaded(): boolean {
  return (posthog as unknown as { __loaded?: boolean }).__loaded === true
}

export function isPostHogReady(): boolean {
  return flushed || isLoaded()
}

/**
 * Make every wrapper a no-op and drop anything already queued. Called once by
 * PostHogProvider when NEXT_PUBLIC_POSTHOG_KEY is absent, so a key-less
 * deployment does zero analytics work rather than buffering forever.
 */
export function disablePostHogClient(): void {
  disabled = true
  queue.length = 0
}

function enqueue(call: QueuedCall): void {
  if (queue.length >= MAX_QUEUED_CALLS) {
    queue.shift()
  }
  queue.push(call)
}

// Identity introspection used by the stitch-safe identify/reset wrappers.
// Typed structurally so the jest posthog-js mocks (which omit these methods)
// keep working — every access is guarded by a typeof check.
type PostHogIdentityIntrospection = {
  get_distinct_id?: () => string
  get_property?: (key: string) => unknown
  _isIdentified?: () => boolean
}

function currentDistinctId(): string | undefined {
  const client = posthog as unknown as PostHogIdentityIntrospection
  if (typeof client.get_distinct_id !== 'function') return undefined
  try {
    return client.get_distinct_id()
  } catch {
    return undefined
  }
}

// True only when posthog's persisted distinct_id belongs to an IDENTIFIED
// user. Anonymous visitors must report false: resetting an anonymous visitor
// regenerates their distinct_id, which orphans every pageview they captured
// before the reset and breaks the anon→identified person merge (the 2026-07
// PostHog audit found 75% of /get-started/activate persons had no pre-auth
// pageviews for exactly this reason). Unknown state therefore fails to false.
function isCurrentlyIdentified(): boolean {
  const client = posthog as unknown as PostHogIdentityIntrospection
  try {
    if (typeof client._isIdentified === 'function') {
      return client._isIdentified()
    }
    // Fallback: identified iff distinct_id has diverged from the device id.
    if (
      typeof client.get_distinct_id === 'function' &&
      typeof client.get_property === 'function'
    ) {
      const deviceId = client.get_property('$device_id')
      return typeof deviceId === 'string' && client.get_distinct_id() !== deviceId
    }
  } catch {
    // Fall through to the fail-safe below.
  }
  return false
}

function runCall(call: QueuedCall): void {
  try {
    if (call.kind === 'capture') {
      posthog.capture(call.event, call.properties)
    } else if (call.kind === 'identify_user') {
      // Skip when posthog already carries this exact distinct_id — identify is
      // only needed on a real state change (anon→user or user A→user B), and
      // skipping keeps re-renders/layout remounts from spamming $set events.
      if (currentDistinctId() !== call.distinctId) {
        posthog.identify(call.distinctId, call.properties)
      }
    } else {
      if (isCurrentlyIdentified()) {
        posthog.reset()
      }
    }
  } catch {
    // Best-effort analytics — a failed call must never surface to the user or
    // bubble to the global error handler.
  }
}

export function captureClient(event: string, properties?: Record<string, unknown>): void {
  if (disabled) return
  if (!isPostHogReady()) {
    enqueue({ kind: 'capture', event, properties })
    return
  }
  runCall({ kind: 'capture', event, properties })
}

/**
 * Stitch-safe identify: links the current (anonymous) distinct_id to the
 * signed-in user's id, letting PostHog merge the pre-auth person into the
 * identified one. No-ops when posthog is already identified as this exact
 * user, so it can be called from every auth-aware layout mount without
 * generating redundant $identify/$set traffic. Pre-init calls are queued and
 * the distinct_id check runs at flush time against the live client.
 */
export function identifyUserClient(distinctId: string, properties?: Record<string, unknown>): void {
  if (disabled) return
  if (!isPostHogReady()) {
    enqueue({ kind: 'identify_user', distinctId, properties })
    return
  }
  runCall({ kind: 'identify_user', distinctId, properties })
}

/**
 * Stitch-safe reset: clears posthog identity ONLY when the persisted
 * distinct_id belongs to an identified user (i.e. a real signed-out state).
 * Never resets an anonymous visitor — an unconditional reset on `!isSignedIn`
 * regenerated the anon distinct_id for every pre-auth visitor entering an
 * auth-aware layout, orphaning their landing pageviews from the person that
 * identify() later created (2026-07 PostHog audit: 140/187 activate-page
 * persons had no pre-auth pageviews).
 */
export function resetIfIdentifiedClient(): void {
  if (disabled) return
  if (!isPostHogReady()) {
    enqueue({ kind: 'reset_if_identified' })
    return
  }
  runCall({ kind: 'reset_if_identified' })
}

// Called from PostHogProvider immediately after posthog.init() returns. Drains
// everything queued during the deferred-init window in FIFO order. Idempotent —
// once flushed, later calls pass straight through.
export function flushPostHogQueue(): void {
  flushed = true
  if (queue.length === 0) {
    return
  }
  const pending = queue.splice(0, queue.length)
  for (const call of pending) {
    runCall(call)
  }
}
