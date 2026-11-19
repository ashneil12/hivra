// The always-on extra: keep more agents awake than the plan includes, billed
// per agent per month on the owner's subscription. Plans bought on the plan
// ladder only, and only while the ladder offers the extra.

export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import { enforceAuthenticatedRouteRateLimit } from "@/lib/authenticated-rate-limit";
import { isSameOriginMutationRequest } from "@/app/api/infrastructure/connections/request-security";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";
import { hasPlanAccessStatus, isLiveStripeSubscriptionId } from "@/lib/billing/subscription-status";
import { isCardTrialSubscription } from "@/lib/billing/card-trial";
import {
  PLAN_LADDER_ID,
  activePlanLadder,
  ladderSubscriptionColumns,
  readLadderSubscription,
} from "@/lib/subscription/plan-ladder";

const Body = z.object({ quantity: z.number().int().min(0).max(100) });

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);
    if (!isSameOriginMutationRequest(req)) return apiError("Same-origin request required.", 403);
    const limited = enforceAuthenticatedRouteRateLimit(req, {
      routeKey: "billing_always_on_extra",
      userId,
      limit: 10,
      windowMs: 10 * 60_000,
    });
    if (limited) return limited;

    const config = activePlanLadder();
    if (!config?.alwaysOnExtra) return apiError("The always-on extra is not available.", 404);

    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return apiError("Send how many extra agents to keep awake.", 400);
    const quantity = parsed.data.quantity;
    if (quantity > config.alwaysOnExtra.maxPerAccount) {
      return apiError(`You can add up to ${config.alwaysOnExtra.maxPerAccount} always-on extras.`, 400);
    }

    const { data: sub, error } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("plan, status, stripe_subscription_id, plan_ladder")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return apiError("Could not read your plan. Please try again.", 503);
    if (!sub || !hasPlanAccessStatus(sub.status) || sub.plan_ladder !== PLAN_LADDER_ID) {
      return apiError("The always-on extra comes with the current plans.", 409);
    }
    if (!isLiveStripeSubscriptionId(sub.stripe_subscription_id)) {
      return apiError("This plan is not attached to a card subscription.", 409);
    }

    const stripe = getStripe();
    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    if (subscription.metadata?.user_id !== userId) {
      log.error("always-on extra refused: subscription belongs to someone else", new Error("subscription user mismatch"), {
        source: "billing-always-on-extra",
        failureType: "always_on_extra_user_mismatch",
        userId,
        subscriptionId: subscription.id,
      });
      return apiError("Your subscription could not be matched to your account.", 409);
    }
    if (isCardTrialSubscription(subscription)) {
      return apiError("Always-on extras are available after your card trial.", 409);
    }
    const ladder = readLadderSubscription(config, subscription);
    if (!ladder.plan) return apiError("Plan changes are paused for a moment. Please try again shortly.", 503);

    if (ladder.alwaysOnExtras === quantity) {
      return apiSuccess({ quantity, unchanged: true });
    }

    const item = ladder.alwaysOnExtraItem;
    const items: Stripe.SubscriptionUpdateParams.Item[] =
      quantity === 0
        ? item?.id ? [{ id: item.id, deleted: true }] : []
        : item?.id
          ? [{ id: item.id, quantity }]
          : [{ price: config.alwaysOnExtra.priceId, quantity }];

    await stripe.subscriptions.update(
      subscription.id,
      { items, proration_behavior: "create_prorations" },
      { idempotencyKey: `always_on_extra_${subscription.id}_${quantity}_${Math.floor(Date.now() / 60_000)}` },
    );

    // The webhook writes the same columns; this makes the change show at once.
    const columns = ladderSubscriptionColumns(config, ladder.plan.planKey, quantity);
    const { error: writeError } = await supabaseAdmin
      .from("hermes_subscriptions")
      .update({
        always_on_limit: columns.always_on_limit,
        always_on_extra: columns.always_on_extra,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .eq("stripe_subscription_id", subscription.id);
    if (writeError) {
      log.warn("always-on extra saved in Stripe, local write failed (webhook will sync)", {
        source: "billing-always-on-extra",
        failureType: "always_on_extra_db_write_failed",
        userId,
        errorMessage: writeError.message,
      });
    }

    return apiSuccess({ quantity, alwaysOnLimit: columns.always_on_limit });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return apiError("Stripe could not update your subscription. Please try again.", 400, {
        failureType: "always_on_extra_stripe_failed",
        stripeErrorType: error.type,
      });
    }
    return apiError("Could not change the always-on extra.", 500, {
      failureType: "always_on_extra_unexpected_error",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
