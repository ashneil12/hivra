export const runtime = "nodejs";

import { auth } from "@clerk/nextjs/server";
import Stripe from "stripe";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";

const ROUTE = "/api/workspace-cloud/billing/portal";

/**
 * Open the Stripe billing portal for the caller's Workspace Cloud subscription.
 * Self-contained to the lane: reads the lane's own stripe_customer_id and
 * returns the user to the Workspace Cloud billing page (never Hivra billing).
 */
export async function POST(request: Request) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`workspace_cloud_portal_${ip}`, { limit: 10, windowMs: 60 * 1000 });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const { data: sub } = await supabaseAdmin
      .from("workspace_cloud_subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", userId)
      .maybeSingle<{ stripe_customer_id: string | null }>();

    if (!sub?.stripe_customer_id) {
      return apiError("No Workspace Cloud subscription found", 404, undefined, undefined, { route: ROUTE });
    }

    const stripe = getStripe();
    const appUrl = getDashboardOrigin();
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: `${appUrl}/workspace-cloud/billing`,
    });

    return apiSuccess({ url: session.url });
  } catch (error) {
    if (error instanceof Stripe.errors.StripeError) {
      return apiError("Failed to open billing portal", 500, { stripeErrorType: error.type }, undefined, { route: ROUTE });
    }
    return handleApiError(error);
  }
}
