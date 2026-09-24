import { apiError } from "@/lib/api-response";

import type { TokenGeoDecision } from "./token-geo-gate";
import { TOKEN_GEO_BLOCKED_CODE } from "./token-geo-policy";

/**
 * The 403 every refused token action returns: `code: "token_geo_blocked"` and
 * the notice as the user-facing error. Kept apart from token-geo-gate.ts so
 * server pages can use the gate without loading the route response helpers.
 */
export function tokenGeoBlockedResponse(
  decision: Extract<TokenGeoDecision, { blocked: true }>,
  context: { source: string; route: string; method: string; userId: string | null }
) {
  return apiError(
    decision.message,
    403,
    { failureType: TOKEN_GEO_BLOCKED_CODE, country: decision.country, signal: decision.signal },
    { code: TOKEN_GEO_BLOCKED_CODE, reason: TOKEN_GEO_BLOCKED_CODE, country: decision.country },
    { ...context, failureType: TOKEN_GEO_BLOCKED_CODE, logLevel: "info" }
  );
}
