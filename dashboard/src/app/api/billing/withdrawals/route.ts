// User-level Bankr withdrawal / earnings history (read-only).
//
// Reads the service-role-only `bankr_withdrawals` table via the admin client and
// returns the authenticated user's withdrawals newest-first. v0 is user-level:
// the table has no owner column, so this spans both the Hermes and Hivra lanes.

import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  getUserWithdrawalHistory,
  normalizeWithdrawalHistoryLimit,
} from "@/lib/billing/withdrawal-history";
import { log } from "@/lib/logger";
import { supabaseAdmin } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET(req: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const limit = normalizeWithdrawalHistoryLimit(
      new URL(req.url).searchParams.get("limit") ?? undefined
    );
    const withdrawals = await getUserWithdrawalHistory(userId, { limit, db: supabaseAdmin });

    return apiSuccess({ withdrawals });
  } catch (error) {
    log.error(
      "withdrawal history fetch failed",
      error instanceof Error ? error : new Error(String(error)),
      { source: "billing/withdrawals", userId: userIdForLog }
    );
    return apiError("Failed to fetch withdrawal history", 500, {
      failureType: "withdrawal_history_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
