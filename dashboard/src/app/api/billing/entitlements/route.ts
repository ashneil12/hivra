import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveReservedCreditBalance, getCreditSummary } from "@/lib/billing/credits";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  evaluateComputeEntitlement,
  normalizeEntitlementInstance,
} from "@/lib/billing/entitlements";
import { getLatestHermesTokenHoldingSnapshot } from "@/lib/billing/token-holdings";
import { SLOT_FREEING_LIFECYCLE_IN_LIST } from "@/lib/instance-lifecycle";

/**
 * GET /api/billing/entitlements
 *
 * Returns a non-enforcing dry-run compute entitlement decision. This is safe to
 * expose before v2 billing enforcement because it does not pause, resume, debit,
 * or block compute.
 */
export async function GET() {
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: subscription } = await supabaseAdmin
      .from("hermes_subscriptions")
      // grace_period_ends_at keeps this read-only report agreeing with the
      // enforcing gate (isProTierUser) about a grace-expired past_due row.
      .select("plan, status, grace_period_ends_at")
      .eq("user_id", userId)
      .maybeSingle();

    const { data: instances, error: instancesError } = await supabaseAdmin
      .from("hermes_instances")
      .select("id, lifecycle_state, status, cpu_limit, ram_limit")
      .eq("user_id", userId)
      .not("status", "in", '("deleted")')
      // Exclude gone/cold-archived instances. A cold_archived row is left at
      // status='stopped' and normalizes to 'paused' (it isn't a recognized
      // lifecycle state), so a status-only filter counts it toward maxInstances
      // and can flip canProvision to false for a user who actually has headroom.
      .not("lifecycle_state", "in", SLOT_FREEING_LIFECYCLE_IN_LIST);

    if (instancesError) {
      return apiError("Failed to evaluate entitlements", 500, {
        failureType: "entitlement_instances_fetch_failed",
      });
    }

    const creditSummary = await getCreditSummary(userId, subscription?.plan ?? null);
    const reservedCredits = await deriveReservedCreditBalance(userId);
    const tokenSnapshot = await getLatestHermesTokenHoldingSnapshot(userId);
    const decision = evaluateComputeEntitlement({
      userId,
      subscription: subscription
        ? {
            plan: subscription.plan,
            status: subscription.status,
            grace_period_ends_at: subscription.grace_period_ends_at ?? null,
          }
        : null,
      creditBalanceCredits: creditSummary.balance,
      reservedCredits,
      tokenHolding: tokenSnapshot
        ? { verified: true, balance: tokenSnapshot.balance }
        : { verified: false, balance: 0 },
      activeInstances: (instances || []).map(normalizeEntitlementInstance),
    });

    return apiSuccess({
      mode: "dry_run",
      enforced: false,
      credits: creditSummary,
      reservedCredits,
      tokenHolding: tokenSnapshot,
      decision,
    });
  } catch (error) {
    return apiError("Failed to evaluate entitlements", 500, {
      failureType: "entitlement_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
