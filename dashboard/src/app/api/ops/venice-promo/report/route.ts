import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import { verifyBearerHeader } from "@/lib/bearer-auth";
import { isOpsAdminUser, verifiedPrimaryEmailOf } from "@/lib/ops-access";
import { supabaseAdmin } from "@/lib/supabase";
import { loadPromoReport } from "@/lib/venice/promo/report";

export const dynamic = "force-dynamic";

/**
 * Admin only: Venice promo report (definitions are in the response).
 * GET /api/ops/venice-promo/report?days=7
 * Auth: Bearer CRON_SECRET, or a Clerk session for an ops admin.
 */
export async function GET(req: NextRequest) {
  if (!verifyBearerHeader(req, process.env.CRON_SECRET)) {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const user = await currentUser();
    if (!isOpsAdminUser({ userId, email: verifiedPrimaryEmailOf(user) })) return apiError("Forbidden", 403);
  }
  if (!supabaseAdmin) return apiError("Database not configured", 500);

  const raw = Number(new URL(req.url).searchParams.get("days") ?? 7);
  const days = Number.isInteger(raw) && raw >= 1 && raw <= 90 ? raw : 7;
  try {
    const report = await loadPromoReport(supabaseAdmin as never, { windowDays: days });
    return apiSuccess(report);
  } catch (error) {
    return apiError("Could not build the Venice promo report", 500, undefined, undefined, {
      source: "ops/venice-promo/report",
      route: "/api/ops/venice-promo/report",
      cause: error,
    });
  }
}
