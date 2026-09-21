import posthog from "posthog-js";

export type HandoffMintOutcome = "ok" | "unauth" | "missing_instance" | "decrypt_failed" | "error";

export type IframeErrorReason =
  | "load"
  | "auth_check_failed"
  | "fetch_url_failed"
  | "open_new_tab_blocked"
  // Instance is stopped (handoff route's 400 "not currently running") — kept
  // distinct from fetch_url_failed so analytics can tell a stopped instance
  // apart from a genuine handoff failure.
  | "instance_not_running"
  // The iframe document loaded, but the chat inside it never confirmed it was
  // alive AND the server-side gateway probe agreed the box is unhealthy. This
  // is the blank-chat case that used to be recorded as a success.
  | "liveness_timeout";

// Outcome of a `webui_iframe_loaded` capture. The DOM load event only proves a
// document finished loading — an HTTP 4xx/5xx error page, a CSP-blocked frame
// and a blank document all reach `document_loaded`. Only `chat_alive` means a
// working chat, so PostHog funnels must compare the two rather than counting
// raw `webui_iframe_loaded` volume.
export type IframeLoadedOutcome = "document_loaded" | "chat_alive";

// Free-form error text cap. Every error/stopped emit path funnels through
// sanitizeDetails below, so no caller can ship an unbounded message to
// PostHog even when an upstream error body is huge.
const MAX_MESSAGE_LENGTH = 200;

// Normalize caller-supplied details before capture:
//   - `reason` is a reserved key (the stable enum PostHog dashboards bucket
//     on). A free-form `reason` detail used to clobber the enum; the
//     spread-order fix then silently DROPPED it instead. Remap it to
//     `pending_reason` so both values survive — the pending-poll repair path
//     passes the server's pending reason (e.g. 'gateway_unreachable') and
//     losing it made repair events undiagnosable.
//   - `message` is free-form error text — cap it at MAX_MESSAGE_LENGTH.
function sanitizeDetails(
  details?: Record<string, unknown>,
): Record<string, unknown> {
  if (!details) return {};
  const { reason, message, ...rest } = details;
  const sanitized: Record<string, unknown> = rest;
  if (reason !== undefined && !("pending_reason" in sanitized)) {
    sanitized.pending_reason = reason;
  }
  if (message !== undefined) {
    sanitized.message =
      typeof message === "string" ? message.slice(0, MAX_MESSAGE_LENGTH) : message;
  }
  return sanitized;
}

export function trackHandoffUrlMint(
  instanceId: string,
  outcome: HandoffMintOutcome,
  details?: Record<string, unknown>,
): void {
  try {
    posthog.capture("webui_handoff_mint", {
      instance_id: instanceId,
      outcome,
      ...details,
    });
  } catch {
    // posthog may not be initialized in tests / SSR — telemetry is best-effort
  }
}

// `outcome` is REQUIRED so no call site can quietly reintroduce the old
// "any completed document load is a success" behaviour: distinguishing
// "document painted" from "chat alive" is the whole point of the event.
export function trackIframeLoaded(
  instanceId: string,
  outcome: IframeLoadedOutcome,
  details?: Record<string, unknown>,
): void {
  try {
    // `outcome` is spread last for the same reason `reason` is on
    // trackIframeError — it is the stable enum dashboards bucket on, so a
    // free-form detail must never shadow it.
    posthog.capture("webui_iframe_loaded", {
      instance_id: instanceId,
      ...sanitizeDetails(details),
      outcome,
    });
  } catch {
    // best-effort
  }
}

export function trackIframeError(
  instanceId: string,
  reason: IframeErrorReason,
  details?: Record<string, unknown>,
): void {
  try {
    // `reason` is spread last so a `details` key can never shadow the stable
    // enum — PostHog dashboards bucket on it. Callers pass the free-form
    // error message under `message` (see WebuiIframe); a stray `reason`
    // detail is preserved as `pending_reason` by sanitizeDetails.
    posthog.capture("webui_iframe_error", {
      instance_id: instanceId,
      ...sanitizeDetails(details),
      reason,
    });
  } catch {
    // best-effort
  }
}

// The EXPECTED parked-box outcome: the mount-time handoff fetch answered
// "instance is not currently running" for a box that is deliberately
// stopped/paused (inactivity pause, manual stop). That's a normal state, not
// a failure — emitting it as its own event keeps parked boxes from drowning
// webui_iframe_error dashboards in noise.
export function trackIframeStopped(
  instanceId: string,
  details?: Record<string, unknown>,
): void {
  try {
    posthog.capture("webui_iframe_stopped", {
      instance_id: instanceId,
      ...sanitizeDetails(details),
    });
  } catch {
    // best-effort
  }
}
