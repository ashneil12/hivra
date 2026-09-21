// Invite & Earn — read the caller's referral code/link + reward stats.
//
// GET → { enabled, code, link, rewardedCount, pendingCount, rewardCreditsPerReferral, maxRewardedReferrals }
//
// Clerk-authed and account-scoped. All storage goes through the server-only
// referral lib (supabaseAdmin). When the feature flag is OFF or the migration is
// unapplied, getReferralSummary degrades to a disabled/empty summary — the route
// still 200s so the UI can render a safe empty state.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

import { auth } from "@clerk/nextjs/server";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { getReferralSummary } from "@/lib/referral";

export async function GET() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    const summary = await getReferralSummary(userId);
    return apiSuccess(summary);
  } catch (err) {
    return handleApiError(err);
  }
}
