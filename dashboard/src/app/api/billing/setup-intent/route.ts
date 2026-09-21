export const runtime = "nodejs";

import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import { apiSuccess, apiError, handleApiError } from "@/lib/api-response";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { attachSetupIntent } from "@/lib/abuse/repository";
import { log } from "@/lib/logger";

const LOG_SOURCE = "billing-setup-intent";

/**
 * POST /api/billing/setup-intent
 *
 * Creates a Stripe SetupIntent for a $0 card-on-file authorization (no
 * charge). Used by the free-tier abuse gate: when a user is flagged
 * "require_card" by the risk scorer, the frontend calls this to obtain a
 * client_secret, then mounts Stripe Elements / PaymentElement to collect
 * the card. On success, Stripe fires setup_intent.succeeded → our webhook
 * → markCardOnFile → user can provision.
 *
 * The endpoint is safe to call proactively: any authenticated user can
 * pre-attach a card without being flagged first. It's idempotent at the
 * row level (upsert keyed on user_id) but will create a *new* SetupIntent
 * each call — Stripe charges nothing for unused intents and they
 * auto-expire, so this is fine in practice.
 */
export async function POST(request: NextRequest) {
  try {
    const ip = getIP(request);
    const { success } = enforceRateLimit(`setup_intent_${ip}`, {
      limit: 5,
      windowMs: 60 * 1000,
    });
    if (!success) {
      return apiError("Too Many Requests", 429);
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    const user = await currentUser();
    const email =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      undefined;
    const name =
      [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim() ||
      undefined;

    // Look up existing Stripe customer (if any) from hermes_subscriptions.
    // validateOrRecreateStripeCustomer handles the cases where the stored
    // ID is missing, deleted upstream, or mismatched — returning a customer
    // ID we can confidently attach a SetupIntent to.
    let storedCustomerId: string | null = null;
    if (supabaseAdmin) {
      const { data, error } = await supabaseAdmin
        .from("hermes_subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", userId)
        .maybeSingle();

      if (error) {
        log.warn("setup-intent customer lookup failed", {
          source: LOG_SOURCE,
          failureType: "customer_lookup_failed",
          userId,
          errorCode: error.code,
        });
      } else if (data?.stripe_customer_id) {
        storedCustomerId = data.stripe_customer_id;
      }
    }

    const { customerId } = await validateOrRecreateStripeCustomer({
      customerId: storedCustomerId,
      clerkUserId: userId,
      email,
      name,
    });

    const stripe = getStripe();
    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      // off_session lets us store the card without immediately charging,
      // and signals to Stripe that we may charge later (matters for SCA /
      // 3DS handling — issuer pre-authorizes future off-session charges).
      usage: "off_session",
      metadata: {
        clerk_user_id: userId,
        purpose: "free_tier_abuse_gate",
      },
    });

    // Persist the intent id so the webhook can find this user when
    // setup_intent.succeeded fires. Belt-and-braces with the metadata —
    // metadata is the primary lookup, this is the fallback if metadata
    // somehow gets stripped (legacy intents, manual API calls, etc).
    await attachSetupIntent({
      userId,
      setupIntentId: setupIntent.id,
    });

    log.info("setup intent created", {
      source: LOG_SOURCE,
      userId,
      setupIntentId: setupIntent.id,
      customerId,
    });

    return apiSuccess({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (err) {
    return handleApiError(err);
  }
}
