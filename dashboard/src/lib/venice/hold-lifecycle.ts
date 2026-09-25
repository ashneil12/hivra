// How long a managed-Venice wallet hold may stay active, and the markers the
// stale-hold sweep (reservation-sweep.ts) leaves on what it settles.
//
// A hold is created right before Hivra forwards a request to Venice and is
// captured or released when Venice answers. When that settlement never runs
// (the function was killed mid-request, the Worker never called back), the
// hold used to stay active for good, shrinking the user's balance for a
// request nobody settled. Every hold now carries an expiry. Past it, with no
// open reconciliation item to say otherwise, the sweep captures it: nothing
// proves Venice did not run the request, and Venice bills Hivra when it does.
//
// Kept separate from reservation-sweep.ts so the chat reconciliation cron can
// read the sweep's marker without loading the sweep.

/** Media requests finish within one function run (at most a few minutes). */
export const MANAGED_VENICE_MEDIA_HOLD_TTL_MS = 60 * 60 * 1000;

/**
 * Chat and Responses streams also finish within one function run, but a kept
 * stream hold waits a day for an operator before the sweep charges its
 * estimate, so an orphaned chat hold gets the same day.
 */
export const MANAGED_VENICE_CHAT_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A chat hold covers the most output its request allows, which with a large
 * or absent output cap can be the model's whole output limit. When Venice
 * answered but the exact usage never reached Hivra (a stream the client
 * cancelled, a missing usage frame), the sweep charges the input estimate
 * plus at most this many output tokens per choice, never more than the
 * pre-request estimate. 4,096 is the output a chat hold has long covered by
 * default.
 */
export const MANAGED_VENICE_SWEEP_OUTPUT_TOKENS_PER_CHOICE = 4_096;

export function managedVeniceHoldExpiresAt(ttlMs: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + ttlMs).toISOString();
}

// Reconciliation reasons the media spend gate files (media-spend-gate.ts).
export const MEDIA_CAPTURE_FAILED_RECONCILIATION_REASON = "managed_venice_media_capture_failed";
export const MEDIA_RELEASE_FAILED_RECONCILIATION_REASON = "managed_venice_media_release_failed";

/**
 * `pricingPolicy` on a usage row the sweep wrote when it captured a hold. A
 * captured chat estimate has no token counts, so the chat reconciliation cron
 * must not re-cost it (it would refund the whole charge as an overcharge).
 */
export const MANAGED_VENICE_SWEEP_CAPTURE_POLICY = "managed_venice_hold_sweep_capture";

export function isManagedVeniceSweepCapture(metadata: unknown): boolean {
  return Boolean(
    metadata &&
      typeof metadata === "object" &&
      (metadata as Record<string, unknown>).pricingPolicy === MANAGED_VENICE_SWEEP_CAPTURE_POLICY
  );
}
