import { apiError } from "@/lib/api-response";
import { enforceRateLimit, getIP, type RateLimitConfig } from "@/lib/rate-limit";

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

export function enforceAuthenticatedRouteRateLimit(
  request: Request,
  options: AuthenticatedRouteRateLimitOptions
) {
  const { routeKey, userId, limit, windowMs } = options;
  const ip = getIP(request);
  const rateLimitKey = `${routeKey}:${userId}:${ip}`;
  const { success } = enforceRateLimit(rateLimitKey, { limit, windowMs });

  return success ? null : apiError("Too Many Requests", 429);
}
