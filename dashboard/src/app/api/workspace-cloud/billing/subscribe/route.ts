export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { z } from "zod";

import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";
import {
  WORKSPACE_CLOUD_PLANS,
  hasDedicatedWorkspaceCloudPrice,
  type WorkspaceCloudPlanKey,
} from "@/lib/subscription/plans";
import { WORKSPACE_CLOUD_SURFACE } from "@/lib/services/workspace-cloud-billing-service";
import { log } from "@/lib/logger";

const ROUTE = "/api/workspace-cloud/billing/subscribe";

const SubscribeSchema = z.object({
  plan: z.enum(["ws_cloud_pro", "ws_cloud_power"]).default("ws_cloud_pro"),
  cadence: z.enum(["monthly", "yearly"]).default("monthly"),
});

function resolveLanePriceId(plan: WorkspaceCloudPlanKey, cadence: "monthly" | "yearly"): string {
  const def = WORKSPACE_CLOUD_PLANS[plan];
  return cadence === "yearly" ? def.stripeYearlyPriceId : def.stripePriceId;
}

/**
 * Start a Stripe Checkout for a Workspace Cloud lane plan. Self-contained: it
 * resolves/creates the user's Stripe customer without touching the Hivra
 * hermes_subscriptions table, and stamps surface=workspace_cloud on both the
 * session and the subscription so the shared webhook routes it to
 * workspace_cloud_subscriptions.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`workspace_cloud_subscribe_${ip}`, {
      limit: 10,
      windowMs: 60 * 1000,
    });
    if (!success) return apiError("Too Many Requests", 429, undefined, undefined, { route: ROUTE });

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401, undefined, undefined, { route: ROUTE });
    if (!supabaseAdmin) return apiError("Database not configured", 500, undefined, undefined, { route: ROUTE });

    const parsed = SubscribeSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return apiError(parsed.error.issues[0].message, 400, undefined, undefined, { route: ROUTE });

    const { plan, cadence } = parsed.data;
    const priceId = resolveLanePriceId(plan, cadence);
    if (!priceId) {
      return apiError(
        `Workspace Cloud ${plan} ${cadence} price is not configured. Set the WORKSPACE_CLOUD_* price env vars.`,
        500,
        undefined,
        undefined,
        { route: ROUTE }
      );
    }

    // FAIL CLOSED on a shared Hivra price. When the dedicated
    // WORKSPACE_CLOUD_*_PRICE_ID env is unset, resolveLanePriceId silently falls
    // back to the Hivra operator/fleet price — which would bill a "Workspace
    // Cloud" subscriber on the Hivra Stripe price, making the two products
    // billing-indistinguishable in Stripe (surface metadata is then the SOLE
    // separation, one bug away from cross-contamination). Refuse rather than
    // charge on the wrong price, unless an operator explicitly opts into shared
    // prices (e.g. canary dogfood before lane prices exist). Defaults OFF so
    // production behavior cannot silently bill on Hivra prices.
    if (
      !hasDedicatedWorkspaceCloudPrice(plan, cadence) &&
      process.env.WORKSPACE_CLOUD_ALLOW_SHARED_PRICE !== "true"
    ) {
      log.error(
        "Workspace Cloud subscribe blocked: no dedicated lane price configured",
        new Error("workspace_cloud_shared_price_blocked"),
        {
          source: "workspace-cloud-billing",
          failureType: "workspace_cloud_shared_price_blocked",
          route: ROUTE,
          userId,
          plan,
          cadence,
        }
      );
      return apiError(
        `Workspace Cloud ${plan} ${cadence} has no dedicated lane price configured. ` +
          `Set WORKSPACE_CLOUD_* price env vars (refusing to bill on the shared Hivra price).`,
        500,
        { failureType: "workspace_cloud_shared_price_blocked" },
        undefined,
        { route: ROUTE }
      );
    }

    // Already subscribed?
    const { data: existing } = await supabaseAdmin
      .from("workspace_cloud_subscriptions")
      .select("stripe_customer_id, status")
      .eq("user_id", userId)
      .maybeSingle<{ stripe_customer_id: string | null; status: string }>();

    if (existing && ["active", "past_due", "trialing"].includes(existing.status)) {
      return apiError("You already have an active Workspace Cloud subscription.", 400, undefined, undefined, { route: ROUTE });
    }

    const stripe = getStripe();
    const user = await currentUser();
    const email =
      user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? undefined;
    const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() || undefined;

    // Resolve a Stripe customer: reuse the lane's stored one, else look up by
    // email, else create. One Stripe customer per user is fine across products.
    let customerId = existing?.stripe_customer_id ?? null;
    if (!customerId && email) {
      const found = await stripe.customers.list({ email, limit: 1 });
      customerId = found.data[0]?.id ?? null;
    }
    if (!customerId) {
      const created = await stripe.customers.create({
        email,
        name,
        metadata: { clerk_user_id: userId },
      });
      customerId = created.id;
    }

    const appUrl = getDashboardOrigin();
    const metadata = {
      user_id: userId,
      plan,
      cadence,
      surface: WORKSPACE_CLOUD_SURFACE,
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_collection: "always",
      client_reference_id: userId,
      customer: customerId,
      metadata,
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: { metadata },
      success_url: `${appUrl}/workspace-cloud/connect?sub=success`,
      cancel_url: `${appUrl}/workspace-cloud/connect?sub=canceled`,
      allow_promotion_codes: true,
    });

    return apiSuccess({ url: session.url });
  } catch (err) {
    return handleApiError(err);
  }
}
