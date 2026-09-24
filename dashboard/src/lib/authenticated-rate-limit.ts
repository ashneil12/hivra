import { apiError } from "@/lib/api-response";
import {
  enforceRateLimit,
  getIP,
  reserveRateLimit,
  type RateLimitConfig,
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

export type AuthenticatedRouteReservation =
  | { limited: null; settle: (outcome: "succeeded" | "failed") => void }
  | { limited: { retryAfterMs: number; inFlight: boolean }; settle: null };

/**
 * Reserve one run of a slow, host-changing operation. Only runs that are still
 * going or that succeeded count against the limit: the route settles the
 * reservation as "failed" when the operation fails, which frees the slot at
 * once. The caller builds the refusal so it can explain it in plain words.
 */
export function reserveAuthenticatedRouteRateLimit(
  request: Request,
  options: AuthenticatedRouteRateLimitOptions,
): AuthenticatedRouteReservation {
  const { limit, windowMs } = options;
  const result = reserveRateLimit(rateLimitKey(request, options), { limit, windowMs });
  return result.success
    ? { limited: null, settle: result.settle }
    : { limited: { retryAfterMs: result.retryAfterMs, inFlight: result.inFlight }, settle: null };
}

/**
 * The refusal for a reserved host operation: a run still going is a conflict
 * (try again when it ends), a recent success is a 429 with an honest
 * Retry-After.
 */
export function hostOperationLimitedResponse(
  limited: { retryAfterMs: number; inFlight: boolean },
  copy: { inFlight: string; recent: string },
): Response {
  if (limited.inFlight) {
    return apiError(copy.inFlight, 409, undefined, { code: "PREPARATION_IN_PROGRESS" });
  }
  return withRetryAfter(
    apiError(`${copy.recent} ${tryAgainInMinutes(retryAfterSeconds(limited.retryAfterMs))}`, 429, undefined, {
      code: "PREPARATION_RATE_LIMITED",
      retryAfterSeconds: retryAfterSeconds(limited.retryAfterMs),
    }),
    limited.retryAfterMs,
  );
}
