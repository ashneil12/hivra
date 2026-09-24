import { apiError } from "@/lib/api-response";
import {
  enforceRateLimit,
  getIP,
  reserveRateLimit,
  type RateLimitConfig,
  type RateLimitRefusalReason,
  type ReservationRateLimitConfig,
} from "@/lib/rate-limit";
import { tryAgainInMinutes } from "@/lib/retry-after-copy";

export const RATE_LIMIT_PRESETS = {
  settingsWrite: { limit: 10, windowMs: 60_000 },
  secretWrite: { limit: 20, windowMs: 60_000 },
  uploadWrite: { limit: 10, windowMs: 5 * 60_000 },
  scheduledTaskWrite: { limit: 20, windowMs: 60_000 },
  conversationWrite: { limit: 20, windowMs: 60_000 },
  messageWrite: { limit: 120, windowMs: 60_000 },
  streamMessageWrite: { limit: 600, windowMs: 60_000 },
} satisfies Record<string, RateLimitConfig>;

interface AuthenticatedRouteRateLimitOptions extends RateLimitConfig {
  routeKey: string;
  userId: string;
}

function rateLimitKey(request: Request, { routeKey, userId }: AuthenticatedRouteRateLimitOptions): string {
  return `${routeKey}:${userId}:${getIP(request)}`;
}

/** Whole seconds until the window resets, never less than one. */
export function retryAfterSeconds(retryAfterMs: number): number {
  return Number.isFinite(retryAfterMs) ? Math.max(1, Math.ceil(retryAfterMs / 1_000)) : 1;
}

function withRetryAfter(response: Response, retryAfterMs: number): Response {
  response.headers.set("Retry-After", String(retryAfterSeconds(retryAfterMs)));
  return response;
}

export function enforceAuthenticatedRouteRateLimit(
  request: Request,
  options: AuthenticatedRouteRateLimitOptions
) {
  const { limit, windowMs } = options;
  const result = enforceRateLimit(rateLimitKey(request, options), { limit, windowMs });

  return result.success
    ? null
    : withRetryAfter(apiError("Too Many Requests", 429), result.retryAfterMs);
}

export type HostOperationLimit = { retryAfterMs: number; inFlight: boolean; reason: RateLimitRefusalReason };

export type AuthenticatedRouteReservation =
  | { limited: null; settle: (outcome: "succeeded" | "failed") => void }
  | { limited: HostOperationLimit; settle: null };

/**
 * Reserve one run of a slow, host-changing operation. Only runs that are still
 * going or that succeeded count against the limit: the route settles the
 * reservation as "failed" when the operation fails, which frees the slot at
 * once. Failures have their own cap (failureLimit per window) so a failing
 * run can't be repeated back to back without end. The caller builds the
 * refusal so it can explain it in plain words.
 */
export function reserveAuthenticatedRouteRateLimit(
  request: Request,
  options: AuthenticatedRouteRateLimitOptions & Pick<ReservationRateLimitConfig, "failureLimit">,
): AuthenticatedRouteReservation {
  const { limit, windowMs, failureLimit } = options;
  const result = reserveRateLimit(rateLimitKey(request, options), { limit, windowMs, failureLimit });
  return result.success
    ? { limited: null, settle: result.settle }
    : { limited: { retryAfterMs: result.retryAfterMs, inFlight: result.inFlight, reason: result.reason }, settle: null };
}

/**
 * The refusal for a reserved host operation: a run still going is a conflict
 * (try again when it ends); a recent success or too many recent failures is a
 * 429 with an honest Retry-After.
 */
export function hostOperationLimitedResponse(
  limited: HostOperationLimit,
  copy: { inFlight: string; recent: string; failures: string },
): Response {
  if (limited.inFlight) {
    return apiError(copy.inFlight, 409, undefined, { code: "PREPARATION_IN_PROGRESS" });
  }
  const seconds = retryAfterSeconds(limited.retryAfterMs);
  const repeatedFailures = limited.reason === "repeated_failures";
  return withRetryAfter(
    apiError(`${repeatedFailures ? copy.failures : copy.recent} ${tryAgainInMinutes(seconds)}`, 429, undefined, {
      code: repeatedFailures ? "PREPARATION_FAILURES_LIMITED" : "PREPARATION_RATE_LIMITED",
      retryAfterSeconds: seconds,
    }),
    limited.retryAfterMs,
  );
}
