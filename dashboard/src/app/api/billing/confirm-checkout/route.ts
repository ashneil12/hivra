import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { apiSuccess, apiError } from "@/lib/api-response";
import { getStripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import { log } from "@/lib/logger";

/**
 * POST /api/billing/confirm-checkout
 *
 * Called immediately after Stripe redirects back with ?session_id=cs_xxx.
 * Validates the session belongs to this user, verifies checkout completion, and activates
 * the subscription in DB without waiting for Stripe webhook delivery.
 *
 * This eliminates the window between "checkout completed" and "webhook arrives"
 * where the user would see "No Active Subscription" and potentially subscribe again.
 */
export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const body = await req.json();
    const { sessionId } = body as { sessionId?: string };

    if (!sessionId || !sessionId.startsWith("cs_")) {
      return apiError("Invalid or missing session ID", 400);
    }

    const stripe = getStripe();

    // Retrieve session from Stripe — source of truth
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["subscription"],
      });
    } catch (err) {
      return apiError("Could not retrieve checkout session", 404, {
        failureType: "confirm_checkout_session_lookup_failed",
        stripeErrorType: err instanceof Stripe.errors.StripeError ? err.type : undefined,
        stripeErrorCode: err instanceof Stripe.errors.StripeError ? err.code : undefined,
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }

    // Verify this session belongs to the authenticated user's Stripe customer
    const { data: sub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", clerkUserId)
      .maybeSingle();

    if (!sub?.stripe_customer_id) {
      return apiError("No subscription record found for user", 404);
    }

    if (session.customer !== sub.stripe_customer_id) {
      log.warn("session customer mismatch", {
        source: "billing-confirm-checkout",
        route: "/api/billing/confirm-checkout",
        method: "POST",
        userId: clerkUserId,
        sessionId,
        sessionCustomer: typeof session.customer === "string" ? session.customer : null,
        userCustomer: sub.stripe_customer_id,
        failureType: "confirm_checkout_session_customer_mismatch",
      });
      return apiError("Session does not belong to this account", 403);
    }

    const checkoutCompleted =
      session.payment_status === "paid" ||
      session.payment_status === "no_payment_required";

    // Must be a completed subscription checkout
    if (session.mode !== "subscription" || !checkoutCompleted) {
      return apiError("Session payment not completed", 402);
    }

    if (!session.subscription) {
      return apiError("No subscription found in session", 422);
    }

    // Extract subscription (may be expanded object or string ID)
    let subscription: Stripe.Subscription;
    if (typeof session.subscription === "string") {
      subscription = await stripe.subscriptions.retrieve(session.subscription);
    } else {
      subscription = session.subscription as Stripe.Subscription;
    }

    // Replay-protection: record this checkout session as activated
    // BEFORE running handleSubscriptionChange. The PRIMARY KEY on
    // stripe_checkout_session_activations.stripe_session_id makes a
    // repeated activation fail with 23505 — we then short-circuit
    // without re-running the side-effect-heavy handler. Defends
    // against bookmarked / replayed `?session_id=...` URLs and any
    // other path that could re-trigger activation.
    const { error: activationErr } = await supabaseAdmin
      .from("stripe_checkout_session_activations")
      .insert({
        stripe_session_id: session.id,
        user_id: clerkUserId,
      });

    if (activationErr) {
      if (activationErr.code === "23505") {
        log.info("checkout session replay — already activated", {
          source: "billing-confirm-checkout",
          route: "/api/billing/confirm-checkout",
          method: "POST",
          userId: clerkUserId,
          subscriptionId: subscription.id,
          sessionId,
        });
        return apiSuccess({
          activated: true,
          alreadyActivated: true,
          plan: subscription.metadata?.plan ?? "unknown",
        });
      }
      // Any other DB failure on the replay-guard is a hard refusal —
      // we don't run handleSubscriptionChange without first confirming
      // we own the activation slot.
      return apiError("Failed to record activation", 500, {
        failureType: "confirm_checkout_activation_record_failed",
        errorCode: activationErr.code,
      });
    }

    // First-time activation — proceed with the side-effect-heavy work. If it
    // fails, RELEASE the replay guard we just claimed so a retry can re-run.
    // Without this, the guard row persists and every subsequent attempt
    // short-circuits as "alreadyActivated" while the subscription was never
    // actually activated — defeating the fast-path until the Stripe webhook
    // backstop eventually catches up.
    try {
      await StripeWebhookService.handleSubscriptionChange(subscription, {
        source: "confirm_checkout",
      });
      await StripeWebhookService.captureCheckoutPaymentCompleted({
        session,
        subscription,
        source: "confirm_checkout",
      });
    } catch (activationError) {
      const { error: releaseError } = await supabaseAdmin
        .from("stripe_checkout_session_activations")
        .delete()
        .eq("stripe_session_id", session.id);
      if (releaseError) {
        log.error(
          "failed to release checkout activation guard after activation error",
          releaseError,
          {
            source: "billing-confirm-checkout",
            route: "/api/billing/confirm-checkout",
            method: "POST",
            userId: clerkUserId,
            sessionId,
            failureType: "confirm_checkout_guard_release_failed",
          }
        );
      }
      throw activationError;
    }

    log.info("activated subscription", {
      source: "billing-confirm-checkout",
      route: "/api/billing/confirm-checkout",
      method: "POST",
      userId: clerkUserId,
      subscriptionId: subscription.id,
    });

    return apiSuccess({ activated: true, plan: subscription.metadata?.plan ?? "unknown" });
  } catch (error) {
    return apiError("Failed to confirm checkout", 500, {
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "confirm_checkout_stripe_failed"
          : "confirm_checkout_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
