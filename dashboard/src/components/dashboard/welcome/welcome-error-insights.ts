/**
 * Shared error classification for the welcome flow's deploy/launch failure
 * paths. Two jobs:
 *
 *   1. Telemetry — `activation_failed` used to fire with no diagnostics
 *      (128 blind events in 5 days on prod). Every failure now carries a
 *      sanitized message plus a coarse category that can be grouped in
 *      PostHog without reading session replays.
 *   2. UX — map the known dead-end error shapes (Proxmox capacity, plan
 *      slot limits) to humane, actionable copy instead of raw backend
 *      errors, while keeping the raw message as secondary detail.
 */

export type WelcomeErrorCategory =
  | 'capacity'
  | 'validation'
  | 'plan_limit'
  | 'network'
  | 'unknown';

export interface WelcomeErrorInsight {
  category: WelcomeErrorCategory;
  /** Friendly, actionable headline. Safe to show as the primary error. */
  headline: string;
  /** Sanitized raw message kept as secondary detail (null when it IS the headline). */
  detail: string | null;
  /** Render the upgrade / manage-agents CTA pair (plan-limit dead ends). */
  showPlanActions: boolean;
  /** The failure is transient — "try again shortly" guidance applies. */
  retryable: boolean;
  /**
   * Present only for the one-base-agent limit (FREE_INSTANCE_LIMIT_REACHED):
   * the user's EXISTING agent, so the error banner can offer "Open your
   * agent" (live) or "Restore your agent" (cold-archived) as the primary
   * action instead of a dead-end upgrade wall. `restorable` mirrors the
   * instance page's cold-storage check (lifecycle cold_archived /
   * pending_deletion or paused_reason cold_archived).
   */
  existingInstance?: { id: string; restorable: boolean };
}

// Defensive redaction for telemetry/UI: anything that looks like a pasted
// credential (provider keys, long opaque tokens) must never leave the client.
const KEY_LIKE_PATTERN = /\b(sk-[A-Za-z0-9_-]{8,}|key-[A-Za-z0-9_-]{8,}|[A-Za-z0-9_-]{40,})\b/g;
const MAX_SANITIZED_LENGTH = 240;

export function sanitizeWelcomeErrorMessage(raw: unknown): string {
  const message =
    raw instanceof Error
      ? raw.message
      : typeof raw === 'string'
        ? raw
        : raw == null
          ? ''
          : String(raw);
  return message
    .replace(/\s+/g, ' ')
    .replace(KEY_LIKE_PATTERN, '[redacted]')
    .trim()
    .slice(0, MAX_SANITIZED_LENGTH);
}

// Host-script internals (cert paths, VMID ranges, seed instructions) must
// never render to users — not even as the smaller secondary detail line.
function containsHostInternals(value: string): boolean {
  return /\[caddy\]|wildcards\/|seed the host/i.test(value);
}

// Managed placement details belong in operator telemetry, not in the customer
// banner. A self-managed owner, however, needs the sanitized host detail to
// repair their own environment. Keep that distinction at render time so the
// same classified error remains useful in both deployment modes.
export function shouldRenderWelcomeErrorDetail(
  insight: WelcomeErrorInsight,
  deploymentMode: 'managed' | 'self-managed',
): boolean {
  if (!insight.detail || insight.detail === insight.headline) return false;
  if (deploymentMode === 'self-managed') return true;
  return !/\bproxmox\b|\bvmid\b|\bnode\b|\bstorage\b|\bbridge\b|\bkvm\b/i.test(insight.detail)
    && !containsHostInternals(insight.detail);
}

export function categorizeWelcomeError(message: string): WelcomeErrorCategory {
  const normalized = message.toLowerCase();
  if (!normalized) return 'unknown';
  // Capacity first — "No free Proxmox VMID in range …" / "Temporary Proxmox
  // capacity reached." must win over the broader plan/limit patterns.
  if (
    normalized.includes('no free proxmox vmid') ||
    normalized.includes('capacity reached') ||
    normalized.includes('at capacity') ||
    normalized.includes('no capacity') ||
    // Placement-failover server copy ("Our capacity system hit a snag
    // provisioning your agent…") plus raw host-script internals that may
    // reach old clients — both are infra-side and retryable.
    normalized.includes('hit a snag provisioning') ||
    containsHostInternals(normalized)
  ) {
    return 'capacity';
  }
  if (
    // "already have one active base-tier agent" is the FreeInstanceLimitError
    // message (one-base-agent guard) — previously fell through to 'unknown',
    // rendering the raw error with no CTAs.
    /plan allows|pool only has|agent slot|slot limit|agent limit|quota exceeded|requires a paid plan|active subscription required|already have one active base-tier agent/.test(
      normalized,
    )
  ) {
    return 'plan_limit';
  }
  if (
    /api key is required|must start with sk-or-|name is required|needs at least|invalid/.test(
      normalized,
    )
  ) {
    return 'validation';
  }
  if (
    /failed to fetch|networkerror|network error|timed out|timeout|connection|aborted|load failed|provision kickoff failed/.test(
      normalized,
    )
  ) {
    return 'network';
  }
  return 'unknown';
}

export const WELCOME_CAPACITY_HEADLINE =
  "We're temporarily at capacity — new agents are paused while we add more server room. Nothing is wrong with your plan or setup; please try again in a few minutes.";

export const WELCOME_NETWORK_HEADLINE =
  "We couldn't reach the deploy service. Check your connection and try again — if your agent was actually created it will appear on your dashboard shortly.";

export function welcomeValidationInsight(message: string): WelcomeErrorInsight {
  return {
    category: 'validation',
    headline: message,
    detail: null,
    showPlanActions: false,
    retryable: false,
  };
}

/**
 * Build the user-facing + telemetry shape for a caught deploy/launch error.
 * The headline is always safe to render; `detail` (when present) is the
 * sanitized raw error, surfaced smaller as secondary context.
 */
export function buildWelcomeErrorInsight(raw: unknown, fallback: string): WelcomeErrorInsight {
  const sanitized = sanitizeWelcomeErrorMessage(raw) || fallback;
  const category = categorizeWelcomeError(sanitized);

  if (category === 'capacity') {
    return {
      category,
      headline: WELCOME_CAPACITY_HEADLINE,
      detail: containsHostInternals(sanitized) ? null : sanitized,
      showPlanActions: false,
      retryable: true,
    };
  }
  if (category === 'plan_limit') {
    // Plan-limit messages ("Your Free plan allows 1 active agent.") are
    // already human-readable — keep them, add the upgrade/manage CTAs.
    return {
      category,
      headline: sanitized,
      detail: null,
      showPlanActions: true,
      retryable: false,
    };
  }
  if (category === 'network') {
    return {
      category,
      headline: WELCOME_NETWORK_HEADLINE,
      detail: sanitized,
      showPlanActions: false,
      retryable: true,
    };
  }
  return {
    category,
    headline: sanitized,
    detail: null,
    showPlanActions: false,
    retryable: false,
  };
}
