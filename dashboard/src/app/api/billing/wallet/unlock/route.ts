/**
 * POST /api/billing/wallet/unlock
 *
 * One-press "unlock my compute now" for the authenticated user — the
 * instant alternative to waiting up to 6h for the refresh-token-tiers cron.
 *
 * Does the full chain in one shot:
 *   1. Fresh on-chain read of the lock wallet (writes new $HERMESOS AND VVV
 *      snapshots — refreshPrimaryHermesTokenHolding loops both tokens).
 *   2. Re-evaluate $HERMESOS tier eligibility (token_tier_qualifications).
 *   3. Re-evaluate the Venice compute boost (VVV ≥ $199, priced via DEX).
 *   4. Resolve the user's effective tier and applyTierChange() so the VM caps
 *      (+ Venice boost) are live-applied immediately — Proxmox qm-set resize;
 *      Hetzner flags tier_change_pending for next redeploy.
 *
 * Rate-limited per user via snapshot recency: a press inside the cooldown
 * window returns the current state without a second chain read / resize, so
 * the button can't hammer the RPC or SSH into Proxmox in a tight loop.
 */

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  refreshPrimaryHermesTokenHolding,
  getLatestHermesTokenHoldingSnapshot,
  VVV_TOKEN_ADDRESS,
} from "@/lib/billing/token-holdings";
import { evaluateAndRecordTokenTierEligibility } from "@/lib/billing/token-tier-eligibility";
import { resolveTokenGeoBlock } from "@/lib/compliance/token-geo-gate";
import { qualifiesForTokenBaseTier, resolveUserTokenAccess } from "@/lib/billing/token-access";
import { evaluateAndRecordVeniceComputeBoost } from "@/lib/billing/venice-compute-boost";
import { fetchVvvPriceUsd } from "@/lib/billing/price-feed";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { applyTierChange } from "@/lib/services/tier-change-service";
import {
  tierFromPlanKey,
  isPaidTier,
  resolveEffectiveTierSpec,
  type TierKey,
} from "@/lib/services/tier-specs";
import {
  redeployPendingResizes,
  PENDING_RESIZE_SELECT,
  type PendingResizeRow,
} from "@/lib/services/pending-resize";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";
import { WEBFREE_BACKENDS } from "@/lib/types/instance";

const LOG_CONTEXT = {
  source: "billing/wallet-unlock",
  route: "/api/billing/wallet/unlock",
  method: "POST",
};

// Minimum seconds between full unlocks per user. A press inside this window
// short-circuits to the current state — bounds the RPC read + Proxmox resize.
const UNLOCK_COOLDOWN_SECONDS = 20;

export async function POST(req?: NextRequest) {
  let userIdForLog: string | null = null;
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }
    const { userId } = await auth();
    userIdForLog = userId ?? null;
    if (!userId) return apiError("Unauthorized", 401);

    // ── Rate limit via snapshot recency ────────────────────────────────
    const lastSnapshot = await getLatestHermesTokenHoldingSnapshot(userId).catch(() => null);
    if (lastSnapshot) {
      const ageMs = Date.now() - new Date(lastSnapshot.checkedAt).getTime();
      if (ageMs < UNLOCK_COOLDOWN_SECONDS * 1000) {
        return apiSuccess({
          throttled: true,
          cooldownSeconds: UNLOCK_COOLDOWN_SECONDS,
          message: "Holdings were just refreshed — your compute is up to date.",
        });
      }
    }

    // ── 1. Fresh chain read (HERMESOS + VVV) ───────────────────────────
    const refresh = await refreshPrimaryHermesTokenHolding({ userId });
    if (refresh.status !== "refreshed" || !refresh.snapshot) {
      return apiError(
        "No verified $HERMESOS lock wallet to unlock. Connect and verify a wallet first.",
        404,
        { failureType: "wallet_unlock_no_wallet" }
      );
    }
    const balances = refresh.balances;
    const access = await resolveUserTokenAccess(userId);

    // ── 2. $HERMESOS tier eligibility ──────────────────────────────────
    let hermesEvaluated = false;
    try {
      // Token geo-policy: existing tiers are re-evaluated as always; a
      // blocked request just can't gain a NEW one. (Without a blocked
      // decision the evaluator still checks the stored country itself.)
      const geo = await resolveTokenGeoBlock(req, { userId });
      await evaluateAndRecordTokenTierEligibility({
        userId,
        balances,
        access,
        ...(geo.blocked ? { tokenGeo: geo } : {}),
      });
      hermesEvaluated = true;
    } catch (err) {
      log.warn("unlock: hermes eligibility eval failed", {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_unlock_hermes_eval_failed",
      }, err);
    }

    // ── 3. Venice compute boost (VVV ≥ $199) ───────────────────────────
    // Best-effort: a DEX price-feed outage skips this step rather than
    // flipping the user off.
    let boostEligible = false;
    let boostEvaluated = false;
    try {
      const vvvSnapshot = (refresh.snapshots ?? []).find(
        (s) => s.tokenAddress === VVV_TOKEN_ADDRESS
      );
      if (vvvSnapshot) {
        const price = await fetchVvvPriceUsd();
        const result = await evaluateAndRecordVeniceComputeBoost({
          userId,
          vvvBalanceRaw: BigInt(vvvSnapshot.balanceRaw),
          vvvPriceUsd: price.priceUsd,
        });
        boostEligible = result.eligible;
        boostEvaluated = true;
      }
    } catch (err) {
      log.warn("unlock: venice boost eval skipped", {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_unlock_boost_eval_skipped",
      }, err);
    }

    // ── 4. Resolve effective tier and live-apply compute ───────────────
    const sub = await resolveEffectiveSubscription(userId);
    let desiredTier: TierKey;
    if (sub && isPaidTier(sub.plan)) {
      desiredTier = tierFromPlanKey(sub.plan);
    } else if (qualifiesForTokenBaseTier(access, balances)) {
      desiredTier = "token_base";
    } else {
      desiredTier = "credit_base";
    }

    // The effective per-instance caps the user now has (tier + boost). This is
    // the single source of truth applyTierChange writes, so we surface it for
    // instant UI feedback.
    const effectiveSpec = resolveEffectiveTierSpec(desiredTier, boostEligible);
    let instancesUpdated = 0;
    let resizeFailures = 0;
    try {
      const outcome = await applyTierChange({
        userId,
        newTier: desiredTier,
        source: "manual",
        veniceBoost: boostEligible,
        reason: "manual wallet unlock",
      });
      instancesUpdated = outcome.instancesUpdated;
      resizeFailures = outcome.resizesFailed.length;
    } catch (err) {
      log.error("unlock: applyTierChange failed", err, {
        ...LOG_CONTEXT,
        userId,
        failureType: "wallet_unlock_apply_failed",
      });
    }

    // Instantly land the new caps on the container(s): redeploy the user's own
    // instances that applyTierChange just flagged. Data-safe (applyLiveUpdate
    // keeps the named volumes). Best-effort: a redeploy hiccup leaves the flag
    // set for the background apply-pending-resizes sweep to retry.
    let redeployed = 0;
    if (supabaseAdmin) {
      try {
        const { data: pendingRows } = await supabaseAdmin
          .from("hermes_instances")
          .select(PENDING_RESIZE_SELECT)
          .eq("user_id", userId)
          .in("backend", WEBFREE_BACKENDS)
          .eq("tier_change_pending", true)
          .not("status", "in", '("deleted","scheduled_for_deletion")');
        const rows = (pendingRows ?? []) as unknown as PendingResizeRow[];
        if (rows.length > 0) {
          const summary = await redeployPendingResizes(rows);
          redeployed = summary.redeployed;
        }
      } catch (err) {
        log.warn("unlock: pending redeploy failed", {
          ...LOG_CONTEXT,
          userId,
          failureType: "wallet_unlock_redeploy_failed",
          errorName: err instanceof Error ? err.name : typeof err,
        });
      }
    }

    return apiSuccess({
      throttled: false,
      hermesEvaluated,
      boostEvaluated,
      tier: desiredTier,
      veniceBoostActive: boostEligible && isPaidTier(desiredTier),
      applied: {
        cpuLimit: effectiveSpec.cpuLimit,
        ramLimit: effectiveSpec.ramLimitMb,
        instancesUpdated,
        resizeFailures,
        redeployed,
      },
    });
  } catch (error) {
    return apiError("Failed to unlock compute.", 500, {
      failureType: "wallet_unlock_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    }, undefined, {
      ...LOG_CONTEXT,
      userId: userIdForLog,
      failureType: "wallet_unlock_failed",
      cause: error,
    });
  }
}
