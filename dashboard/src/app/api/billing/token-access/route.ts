/**
 * GET  /api/billing/token-access               → the user's platform-token access
 * POST /api/billing/token-access  { action: "convert" }
 *      → a grandfathered $HermesOS user switches to $HIVRA.
 *
 * Before $HIVRA is active every account is $HermesOS-only and convert is
 * refused. After activation, grandfathered accounts keep $HermesOS until they
 * convert; converting starts a TOKEN_CONVERSION_GRACE_HOURS window in which
 * either token keeps their tier (see lib/billing/token-access.ts).
 */
import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { BILLING_V2_UNAVAILABLE_MESSAGE, isBillingV2ServerEnabled } from "@/lib/billing/billing-v2-availability";
import { isCryptoBillingEnabled } from "@/lib/billing/crypto-availability";
import {
  TokenConversionError,
  convertGrandfatheredUserToHivra,
  resolveUserTokenAccess,
  type UserTokenAccess,
} from "@/lib/billing/token-access";
import { TOKEN_CONVERSION_GRACE_HOURS } from "@/lib/billing/token-registry";

const LOG_CONTEXT = { source: "billing/token-access", route: "/api/billing/token-access" };

function serializeAccess(access: UserTokenAccess) {
  return {
    phase: access.phase,
    grandfathered: access.grandfathered,
    allowedTokens: access.allowedTokens,
    paymentToken: access.paymentToken,
    canConvert: access.phase === "active" && access.grandfathered && !access.convertedAt,
    convertedAt: access.convertedAt?.toISOString() ?? null,
    conversionGraceEndsAt: access.conversionGraceEndsAt?.toISOString() ?? null,
    conversionGraceHours: TOKEN_CONVERSION_GRACE_HOURS,
  };
}

function surfaceEnabled() {
  return isBillingV2ServerEnabled() && isCryptoBillingEnabled();
}

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    if (!surfaceEnabled()) return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    return apiSuccess(serializeAccess(await resolveUserTokenAccess(userId)));
  } catch (error) {
    return apiError("Failed to load token access.", 500, { failureType: "token_access_load_failed" }, undefined, {
      ...LOG_CONTEXT,
      method: "GET",
      userId: userIdForLog,
      failureType: "token_access_load_failed",
      cause: error,
    });
  }
}

export async function POST(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!surfaceEnabled()) return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    let body: { action?: unknown } = {};
    try {
      body = (await req.json()) as { action?: unknown };
    } catch {
      return apiError("Invalid JSON body.", 400);
    }
    if (body.action !== "convert") {
      return apiError("Unknown action — expected 'convert'.", 400, { failureType: "token_access_bad_action" });
    }

    const rateLimited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "billing-token-access-convert",
      userId,
      ...RATE_LIMIT_PRESETS.secretWrite,
    });
    if (rateLimited) return rateLimited;

    const access = await convertGrandfatheredUserToHivra(userId);
    return apiSuccess(serializeAccess(access));
  } catch (error) {
    if (error instanceof TokenConversionError) {
      const status = error.code === "price_unavailable" ? 503 : 409;
      return apiError(error.message, status, { failureType: `token_conversion_${error.code}` });
    }
    return apiError("Failed to switch to $HIVRA.", 500, { failureType: "token_conversion_failed" }, undefined, {
      ...LOG_CONTEXT,
      method: "POST",
      userId: userIdForLog,
      failureType: "token_conversion_failed",
      cause: error,
    });
  }
}
