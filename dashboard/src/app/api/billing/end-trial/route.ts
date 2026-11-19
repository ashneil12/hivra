// "Upgrade to full Pro now": ends the card trial early. Stripe charges the card
// right away and the paid event gives the account the full plan. A failed
// charge throws and leaves the trial as it was.

import Stripe from "stripe";
import { auth } from "@clerk/nextjs/server";
import { apiError, apiSuccess } from "@/lib/api-response";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";
import { isCardTrialSubscription } from "@/lib/billing/card-trial";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";

const SOURCE = "billing-end-trial";

export async function POST() {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);
    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: row, error } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("stripe_subscription_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return apiError("Unable to check your plan right now. Please try again.", 503);
    const subscriptionId = (row as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id;
    if (!subscriptionId) return apiError("You're not on a free trial.", 409, undefined, { reason: "not_in_trial" });

    const stripe = getStripe();
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    if (current.metadata?.user_id !== userId || !isCardTrialSubscription(current)) {
      return apiError("You're not on a free trial.", 409, undefined, { reason: "not_in_trial" });
    }

    let updated: Stripe.Subscription;
    try {
      updated = await stripe.subscriptions.update(subscriptionId, {
        trial_end: "now",
        payment_behavior: "error_if_incomplete",
      });
    } catch (stripeError) {
      log.warn("ending the card trial early failed", {
        source: SOURCE,
        failureType: "card_trial_end_now_failed",
        userId,
        subscriptionId,
        stripeErrorCode: stripeError instanceof Stripe.errors.StripeError ? stripeError.code : undefined,
      });
      return apiError(
        "Your card couldn't be charged, so your trial continues. Update your card in Billing and try again.",
        402,
        undefined,
        { reason: "payment_failed" }
      );
    }

    // Apply the full plan now instead of waiting for the webhook.
    await StripeWebhookService.handleSubscriptionChange(updated, { source: "stripe_webhook" });
    log.info("card trial ended early; full plan active", { source: SOURCE, userId, subscriptionId });
    return apiSuccess({ upgraded: updated.status === "active" });
  } catch (error) {
    log.error("end trial failed", error, { source: SOURCE, failureType: "card_trial_end_failed" });
    return apiError("Couldn't upgrade right now. Please try again.", 500);
  }
}
