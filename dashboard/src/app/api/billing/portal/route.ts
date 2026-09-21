import { auth, currentUser } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  enforceAuthenticatedRouteRateLimit,
  RATE_LIMIT_PRESETS,
} from "@/lib/authenticated-rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";

export async function POST(request: Request) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);

    // Each call hits Stripe's API to create a portal session; without a
    // limit, an authed adversary can burn shared Stripe-API quota for the
    // platform. settingsWrite (10/60s) matches the cadence of legit users.
    const rateLimitError = enforceAuthenticatedRouteRateLimit(request, {
      routeKey: "billing_portal_post",
      userId: clerkUserId,
      ...RATE_LIMIT_PRESETS.settingsWrite,
    });
    if (rateLimitError) return rateLimitError;

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    const { data: sub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", clerkUserId)
      .maybeSingle();

    if (!sub) {
      return apiError("No active subscription found", 404);
    }

    // Validate customer still exists
    const clerkUser = await currentUser();
    const email = clerkUser?.emailAddresses?.[0]?.emailAddress;
    const name = [clerkUser?.firstName, clerkUser?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    const { customerId } = await validateOrRecreateStripeCustomer({
      customerId: sub.stripe_customer_id,
      clerkUserId,
      email,
      name,
    });

    const stripe = getStripe();
    const appUrl = getDashboardOrigin();

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${appUrl}/dashboard/billing`,
    });

    return apiSuccess({ url: session.url });
  } catch (error) {
    return apiError("Failed to create portal session", 500, {
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "billing_portal_stripe_failed"
          : "billing_portal_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
