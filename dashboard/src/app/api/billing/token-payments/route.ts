/**
 * GET /api/billing/token-payments → whether Billing may offer this account
 * token payments and new holder tiers right now, and in which token.
 *
 *   { available, paymentToken, displayUnit }
 *
 * Before $HIVRA is active, and for the $HermesOS grandfather cohort, this is
 * always available (in the account's payment token). For everyone else it is
 * available only while $HIVRA is usable: live and passing the price gate
 * (lib/billing/hivra-readiness.ts). The quote and holding routes enforce the
 * same rule server-side; this only tells the page what to show.
 *
 * Not behind the billing flags: it reveals nothing beyond what those routes
 * would answer, and the page needs it under any flag combination.
 */
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { resolveTokenPaymentAvailability } from "@/lib/billing/hivra-readiness";
import { resolveUserTokenAccess } from "@/lib/billing/token-access";

const LOG_CONTEXT = { source: "billing/token-payments", route: "/api/billing/token-payments", method: "GET" };

export async function GET() {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    const access = await resolveUserTokenAccess(userId, { recordMembership: false });
    return apiSuccess(await resolveTokenPaymentAvailability(access));
  } catch (error) {
    return apiError("Failed to load token payment availability.", 500, {
      failureType: "token_payments_load_failed",
    }, undefined, {
      ...LOG_CONTEXT,
      userId: userIdForLog,
      failureType: "token_payments_load_failed",
      cause: error,
    });
  }
}
