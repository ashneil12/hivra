import "server-only";

import { supabaseAdmin } from "@/lib/supabase";
import { deriveReservedCreditBalance, getCreditSummary } from "@/lib/billing/credits";
import {
  evaluateComputeEntitlement,
  normalizeEntitlementInstance,
} from "@/lib/billing/entitlements";
import { getLatestAccessTokenHoldingSnapshot } from "@/lib/billing/token-access";
import type { TierKey } from "@/lib/services/tier-specs";

// Single source of truth for "is this user entitled to a Pro+ feature?".
//
// Pro+ = operator | fleet | command. Everything else (credit_base, token_base,
// undefined) returns false. Network/DB failures fail closed — better to deny
// access during a transient outage than leak a paid feature to a free user.
//
// Use at:
//   - Toggle PATCH endpoints (block enable for non-Pro+).
//   - Provisioning code (resolve before passing browserSidecarEnabled into
//     the compose builder; do not trust the persisted toggle alone).
//   - Reconcile/redeploy paths (re-check on every redeploy so a downgrade
//     drops the service block on next compose render).

const PRO_PLUS_TIERS = new Set<TierKey>(["operator", "fleet", "command"]);

export interface ProTierCheck {
  ok: boolean;
  tier: TierKey | null;
  reason?: string;
}

export async function isProTierUser(userId: string): Promise<ProTierCheck> {
  if (!supabaseAdmin) {
    return { ok: false, tier: null, reason: "no_db" };
  }
  try {
    const [{ data: subscription }, { data: instances }, creditSummary, reservedCredits, tokenSnapshot] =
      await Promise.all([
        supabaseAdmin
          .from("hermes_subscriptions")
          // grace_period_ends_at feeds the dunning cutoff in
          // evaluateComputeEntitlement — without it a grace-expired past_due
          // row keeps every Pro+ feature for Stripe's whole retry window.
          .select("plan, status, grace_period_ends_at")
          .eq("user_id", userId)
          .maybeSingle<{
            plan: string | null;
            status: string | null;
            grace_period_ends_at: string | null;
          }>(),
        supabaseAdmin
          .from("hermes_instances")
          .select("id, lifecycle_state, status, cpu_limit, ram_limit")
          .eq("user_id", userId)
          .not("status", "in", '("deleted")'),
        getCreditSummary(userId, null),
        deriveReservedCreditBalance(userId),
        getLatestAccessTokenHoldingSnapshot(userId),
      ]);

    const decision = evaluateComputeEntitlement({
      userId,
      subscription: subscription
        ? {
            plan: subscription.plan ?? "",
            status: subscription.status ?? "",
            grace_period_ends_at: subscription.grace_period_ends_at ?? null,
          }
        : null,
      creditBalanceCredits: creditSummary.balance,
      reservedCredits,
      tokenHolding: tokenSnapshot
        ? { verified: true, balance: tokenSnapshot.balance }
        : { verified: false, balance: 0 },
      activeInstances: (instances ?? []).map(normalizeEntitlementInstance),
    });

    if (!decision.allowedTier) {
      return { ok: false, tier: null, reason: "no_entitlement" };
    }
    const tier = decision.allowedTier as TierKey;
    if (PRO_PLUS_TIERS.has(tier)) {
      return { ok: true, tier };
    }
    return { ok: false, tier, reason: "tier_below_pro" };
  } catch (err) {
    return {
      ok: false,
      tier: null,
      reason: `lookup_failed:${(err as Error).message}`,
    };
  }
}
