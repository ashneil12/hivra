import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import {
  PLANS,
  PLAN_ORDER,
  isPlanUpgrade,
  isPaidPlanDowngrade,
  type PlanKey,
} from "@/lib/subscription";
import {
  hasPlanAccessStatus,
  isLiveStripeSubscriptionId,
} from "@/lib/billing/subscription-status";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { applyTierChange } from "@/lib/services/tier-change-service";
import { tierFromPlanKey } from "@/lib/services/tier-specs";
import { reportOpsEvent } from "@/lib/ops-events";
import { log } from "@/lib/logger";

/**
 * Self-serve plan DOWNGRADE (e.g. Power → Pro) is gated behind this flag so
 * it ships dark for canary review before going live. Default OFF: when unset
 * the route keeps the historical "downgrades not available" rejection verbatim.
 *
 * The owner decision for downgrades is STANDARD PRORATION CREDIT — Stripe is
 * told `proration_behavior: 'create_prorations'`, which credits the unused
 * time on the higher plan toward the customer's future invoices.
 */
function isSelfServeDowngradeEnabled(): boolean {
  return process.env.HERMES_SELF_SERVE_DOWNGRADE_ENABLED === "true";
}

/**
 * The exact rejection the route has always returned for downgrades. Kept as a
 * named constant so the flag-off path is byte-for-byte identical to the
 * pre-Batch-6 behavior.
 */
const DOWNGRADE_UNAVAILABLE_MESSAGE =
  "Plan downgrades are not available due to dedicated server infrastructure. " +
  "You can upgrade your plan anytime. To switch to a lower tier, cancel your " +
  "subscription and re-subscribe — note this will remove your current server.";

const Schema = z.object({
  newPlan: z.enum(["operator", "fleet", "command"]),
});

function stripeCustomerId(customer: Stripe.Subscription["customer"]): string | null {
  if (typeof customer === "string") return customer;
  if (customer && typeof customer === "object" && "id" in customer) return customer.id;
  return null;
}

/**
 * POST /api/billing/change-plan
 *
 * Switches the user's Stripe subscription to a different plan.
 *
 * Upgrade: always allowed — Stripe charges prorated difference immediately.
 * Downgrade (paid → lower paid, e.g. Power → Pro): allowed only when
 *   HERMES_SELF_SERVE_DOWNGRADE_ENABLED is "true". Stripe is updated with
 *   proration_behavior:'create_prorations', which credits the unused time on
 *   the higher plan toward future invoices. Downgrade-to-free is NOT handled
 *   here (that is a cancellation). When the flag is off we keep the historical
 *   "downgrades not available" rejection verbatim.
 *
 * On success, Stripe fires `customer.subscription.updated` which the webhook
 * handler uses to sync the DB and call applyTierChange. We also update the DB
 * optimistically here AND call applyTierChange inline (idempotent) so the UI
 * reflects the change immediately and the VM resizes without waiting on the
 * webhook round-trip.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const body = await req.json();
    const parsed = Schema.safeParse(body);
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400);

    const { newPlan } = parsed.data;

    // ── 1. Load current subscription ────────────────────────────────────────
    const { data: sub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select(
        "plan, status, stripe_subscription_id, stripe_customer_id, total_cpu_budget, total_ram_budget, instance_limit"
      )
      .eq("user_id", clerkUserId)
      .maybeSingle();

    if (!sub || !hasPlanAccessStatus(sub.status)) {
      return apiError("No active subscription found. Please subscribe first.", 404);
    }

    const currentPlan = sub.plan as PlanKey;
    // Captured before the free-plan guard narrows `currentPlan` — used by the
    // write-once conversion stamp on the optimistic update below.
    const wasFreePlan = currentPlan === "free";

    if (currentPlan === newPlan) {
      return apiError("You are already on this plan.", 400);
    }

    if (currentPlan === "free") {
      return apiError(
        "Free plan upgrades must start secure checkout. Please choose a paid plan from billing.",
        409,
        { failureType: "change_plan_free_requires_checkout" }
      );
    }

    const targetPlan = PLANS[newPlan];
    const isUpgrade = isPlanUpgrade(currentPlan, newPlan);
    const isDowngrade = !isUpgrade;

    // ── 2. Downgrade gating ──────────────────────────────────────────────────
    // Self-serve downgrades (paid → lower paid, e.g. Power → Pro) are gated
    // behind HERMES_SELF_SERVE_DOWNGRADE_ENABLED so they ship dark for canary
    // review. When the flag is OFF we keep the historical rejection verbatim.
    if (isDowngrade) {
      const downgradeEnabled = isSelfServeDowngradeEnabled();

      // Flag off → unchanged behavior. Dedicated server infrastructure cannot
      // be scaled down in-place; users must cancel and re-subscribe.
      if (!downgradeEnabled) {
        return apiError(DOWNGRADE_UNAVAILABLE_MESSAGE, 403);
      }

      // Flag on, but the requested move isn't a real paid→lower-paid downgrade.
      // The only `!isUpgrade` case that survives the guards above and is NOT a
      // paid→paid downgrade is a target of `free` (currentPlan==="free" and
      // currentPlan===newPlan are already rejected). Moving to free is a
      // cancellation, not a downgrade — route the user to the cancel flow.
      if (!isPaidPlanDowngrade(currentPlan, newPlan)) {
        return apiError(
          "To move to the Free plan, cancel your subscription instead — " +
            "in-place plan changes only switch between paid tiers.",
          400,
          { failureType: "change_plan_downgrade_to_free_not_supported" }
        );
      }
    }

    const usesManualSubscription = !isLiveStripeSubscriptionId(sub.stripe_subscription_id);

    if (usesManualSubscription) {
      log.warn("change-plan blocked: paid row has no live Stripe subscription", {
        source: "billing-change-plan",
        route: "/api/billing/change-plan",
        method: "POST",
        userId: clerkUserId,
        previousPlan: currentPlan,
        newPlan,
        hasStripeSubscriptionId: Boolean(sub.stripe_subscription_id),
        manualSubscription:
          typeof sub.stripe_subscription_id === "string" &&
          sub.stripe_subscription_id.startsWith("manual_"),
      });
      return apiError(
        "This plan is not attached to a live Stripe subscription. Please use secure checkout to switch plans.",
        409,
        { failureType: "change_plan_manual_requires_checkout" }
      );
    }

    // ── 3. Validate Stripe customer & Update Subscription ───────────────────
    const clerkUser = await currentUser();
    const email = clerkUser?.emailAddresses?.[0]?.emailAddress;
    const name = [clerkUser?.firstName, clerkUser?.lastName].filter(Boolean).join(" ").trim();

    const validation = await validateOrRecreateStripeCustomer({
      customerId: sub.stripe_customer_id,
      clerkUserId,
      email,
      name,
    });

    // If the validated customer differs from the row's stored customer
    // (recreated upstream, owner-mismatch, etc.), the existing
    // `stripe_subscription_id` is bound to a different Stripe customer
    // — calling `subscriptions.update` against it would either fail or,
    // worse, mutate someone else's subscription while our local DB
    // optimistically bumps THIS user's plan/limits. Refuse and force a
    // fresh subscribe flow.
    if (
      validation.wasRecreated ||
      validation.customerId !== sub.stripe_customer_id
    ) {
      log.warn("change-plan blocked: stripe customer was recreated/mismatched", {
        source: "billing-change-plan",
        route: "/api/billing/change-plan",
        method: "POST",
        userId: clerkUserId,
        previousCustomerId: sub.stripe_customer_id,
        validatedCustomerId: validation.customerId,
      });
      return apiError(
        "Your Stripe customer record needs to be re-linked. Please cancel and re-subscribe to switch plans.",
        409,
        { failureType: "change_plan_customer_recreated" }
      );
    }

    const stripe = getStripe();
    const stripeSubscription = await stripe.subscriptions.retrieve(
      sub.stripe_subscription_id
    );
    const retrievedCustomerId = stripeCustomerId(stripeSubscription.customer);
    if (!retrievedCustomerId || retrievedCustomerId !== validation.customerId) {
      log.warn("change-plan blocked: subscription/customer mismatch", {
        source: "billing-change-plan",
        route: "/api/billing/change-plan",
        method: "POST",
        userId: clerkUserId,
        subscriptionId: sub.stripe_subscription_id,
        storedCustomerId: sub.stripe_customer_id,
        validatedCustomerId: validation.customerId,
        retrievedCustomerId,
      });
      return apiError(
        "Your Stripe subscription is not linked to the current customer record. Please cancel and re-subscribe to switch plans.",
        409,
        { failureType: "change_plan_subscription_customer_mismatch" }
      );
    }

    const subscriptionItemId = stripeSubscription.items.data[0]?.id;
    if (!subscriptionItemId) {
      return apiError("Stripe subscription item not found. Please contact support.", 500);
    }

    const updatedSubscription = await stripe.subscriptions.update(
      sub.stripe_subscription_id,
      {
        items: [
          {
            id: subscriptionItemId,
            price: targetPlan.stripePriceId,
          },
        ],
        proration_behavior: "create_prorations",
        metadata: {
          user_id: clerkUserId,
          plan: newPlan,
          previous_plan: currentPlan,
          changed_at: new Date().toISOString(),
        },
      }
    );

    log.info(isUpgrade ? "plan upgraded" : "plan downgraded", {
      source: "billing-change-plan",
      route: "/api/billing/change-plan",
      method: "POST",
      userId: clerkUserId,
      previousPlan: currentPlan,
      newPlan,
      direction: isUpgrade ? "upgraded" : "downgraded",
      prorationBehavior: "create_prorations",
      subscriptionId: updatedSubscription.id,
    });

    // ── 6. Optimistic DB update (webhook will also confirm this) ─────────────
    await supabaseAdmin
      .from("hermes_subscriptions")
      .update({
        plan: newPlan,
        instance_limit: targetPlan.maxAgents,
        total_cpu_budget: targetPlan.totalCpu,
        total_ram_budget: targetPlan.totalRam,
        excess_resources: false,
        updated_at: new Date().toISOString(),
        // Conversion stamp (write-once): only a free->paid transition counts
        // as the first upgrade. Paid->paid plan changes OMIT the keys so the
        // original conversion timestamp can never move. (Free rows are
        // currently routed to checkout above, so this is defensive.)
        ...(wasFreePlan
          ? {
              upgraded_at: new Date().toISOString(),
              upgrade_source: "change_plan",
            }
          : {}),
      })
      .eq("user_id", clerkUserId);

    // ── 7. Apply the tier change inline (idempotent) ─────────────────────────
    // The resulting customer.subscription.updated webhook ALSO calls
    // applyTierChange, but we run it inline so the VM resizes (down, for a
    // downgrade) and the entitlement caps land immediately rather than waiting
    // on the webhook round-trip. applyTierChange is idempotent — a duplicate
    // call from the webhook re-applies the same caps and no-ops the resize.
    // NON-FATAL: the Stripe update + DB write are already the source of truth,
    // so a resize hiccup must not fail the request (mirrors the webhook, which
    // logs and continues). The webhook retry is the backstop.
    try {
      const outcome = await applyTierChange({
        userId: clerkUserId,
        newTier: tierFromPlanKey(newPlan),
        source: "stripe",
        reason: `${isUpgrade ? "upgrade" : "downgrade"} ${currentPlan}->${newPlan} via change-plan`,
      });
      if (outcome.resizesFailed.length > 0) {
        log.warn("change-plan tier-change had resize failures", {
          source: "billing-change-plan",
          route: "/api/billing/change-plan",
          method: "POST",
          failureType: "change_plan_tier_change_partial_failure",
          userId: clerkUserId,
          newPlan,
          failedResizeCount: outcome.resizesFailed.length,
        });
      }
    } catch (tierErr) {
      log.error("change-plan inline applyTierChange failed", tierErr, {
        source: "billing-change-plan",
        route: "/api/billing/change-plan",
        method: "POST",
        failureType: "change_plan_tier_change_failed",
        userId: clerkUserId,
        previousPlan: currentPlan,
        newPlan,
      });
    }

    // Surface downgrades to the ops feed for canary review while the feature
    // ships dark. Best-effort — a feed write must never fail the request.
    if (isDowngrade) {
      await reportOpsEvent({
        source: "billing-change-plan",
        severity: "info",
        title: "Self-serve plan downgrade",
        message: `User downgraded ${currentPlan} -> ${newPlan} (proration credit applied)`,
        route: "/api/billing/change-plan",
        userId: clerkUserId,
        metadata: {
          previousPlan: currentPlan,
          newPlan,
          subscriptionId: updatedSubscription.id,
          prorationBehavior: "create_prorations",
        },
      }).catch(() => {});
    }

    const planOrder = PLAN_ORDER;
    const fromIndex = planOrder.indexOf(currentPlan);
    const toIndex = planOrder.indexOf(newPlan);

    return apiSuccess({
      previousPlan: currentPlan,
      newPlan,
      direction: isUpgrade ? "upgraded" : "downgraded",
      skippedTiers: Math.abs(toIndex - fromIndex) - 1,
      message: isUpgrade
        ? `Successfully upgraded to ${targetPlan.name}. Prorated charge applied.`
        : `Switched to ${targetPlan.name}. You'll get account credit for the unused time on your previous plan.`,
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      return apiError(
        "Unable to update Stripe billing for the plan change. Please try again.",
        400,
        {
          failureType: "change_plan_stripe_failed",
          stripeErrorType: err.type,
        }
      );
    }
    return apiError(
      "Failed to change plan. Please try again.",
      500,
      {
        failureType: "change_plan_unexpected_error",
        errorName: err instanceof Error ? err.name : typeof err,
      }
    );
  }
}
