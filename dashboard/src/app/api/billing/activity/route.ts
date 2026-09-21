import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { getBillingActivity, normalizeBillingActivityLimit } from "@/lib/billing/activity";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export async function GET(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const limit = normalizeBillingActivityLimit(new URL(req.url).searchParams.get("limit"));
    const activity = await getBillingActivity(userId, { limit }, supabaseAdmin);

    return apiSuccess(activity);
  } catch (error) {
    log.error(
      "billing activity fetch failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "billing/activity", userId: userIdForLog }
    );
    return apiError("Failed to fetch billing activity", 500, {
      failureType: "billing_activity_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
