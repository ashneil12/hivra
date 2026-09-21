import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";
import { apiSuccess, apiError } from "@/lib/api-response";
import { getIP } from "@/lib/rate-limit";
import { supabaseAdmin } from "@/lib/supabase";
import { PLANS, PlanKey, getStripePriceId, planRank, type Cadence } from "@/lib/subscription";
import { resolveEffectiveSubscription } from "@/lib/billing/instance-entitlement";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";
import { BILLING_SUBSCRIBE_REASON } from "@/lib/billing/subscribe-errors";
import {
  bucketForUser,
  getTrialDaysForUser,
  isTrialExperimentEnabled,
} from "@/lib/billing/trial-experiment";
import { posthogClient } from "@/lib/posthog";
import {
  hasPlanAccessStatus,
  isLiveStripeSubscriptionId,
} from "@/lib/billing/subscription-status";
import { log } from "@/lib/logger";

// First-touch UTM/referrer stash captured client-side (PostHogProvider) and
// forwarded by the billing client on the first subscribe call. Unknown keys
// are stripped by zod; every field is optional so a partial stash still lands.
const SignupAttributionSchema = z.object({
  utm_source: z.string().trim().max(256).optional(),
  utm_medium: z.string().trim().max(256).optional(),
  utm_campaign: z.string().trim().max(256).optional(),
  utm_term: z.string().trim().max(256).optional(),
  utm_content: z.string().trim().max(256).optional(),
  referrer: z.string().trim().max(256).optional(),
  landing_page: z.string().trim().max(256).optional(),
  captured_at: z.number().optional(),
});

type SignupAttribution = z.infer<typeof SignupAttributionSchema>;

const SubscribeRequestSchema = z.object({
  plan: z.string().trim().min(1),
  // Default "monthly" so older clients that don't send a cadence keep
  // landing on the existing monthly Stripe price exactly as before.
  cadence: z.enum(["monthly", "yearly"]).default("monthly"),
  attribution: SignupAttributionSchema.optional(),
});

const RECENT_PENDING_CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

function buildPendingSubscriptionRecord({
  clerkUserId,
  stripeCustomerId,
  planKey,
  attribution = null,
}: {
  clerkUserId: string;
  stripeCustomerId: string;
  planKey: PlanKey;
  attribution?: SignupAttribution | null;
}) {
  const plan = PLANS[planKey];

  return {
    user_id: clerkUserId,
    stripe_customer_id: stripeCustomerId,
    plan: planKey,
    status: "pending",
    instance_limit: plan.maxAgents,
    total_cpu_budget: plan.totalCpu,
    total_ram_budget: plan.totalRam,
    updated_at: new Date().toISOString(),
    // First-touch only: the key is omitted entirely (not nulled) unless we
    // have fresh attribution AND the existing row has none, so upserts can
    // never clobber an earlier capture.
    ...(attribution ? { signup_attribution: attribution } : {}),
  };
}

function buildActiveFreeSubscriptionRecord({
  clerkUserId,
  stripeCustomerId = null,
  attribution = null,
}: {
  clerkUserId: string;
  stripeCustomerId?: string | null;
  attribution?: SignupAttribution | null;
}) {
  const plan = PLANS.free;

  return {
    user_id: clerkUserId,
    stripe_customer_id: stripeCustomerId,
    stripe_subscription_id: null,
    plan: "free" as PlanKey,
    status: "active",
    instance_limit: plan.maxAgents,
    total_cpu_budget: plan.totalCpu,
    total_ram_budget: plan.totalRam,
    current_period_start: new Date().toISOString(),
    current_period_end: null,
    grace_period_ends_at: null,
    updated_at: new Date().toISOString(),
    ...(attribution ? { signup_attribution: attribution } : {}),
  };
}

function isRecentPendingCheckout(updatedAt?: string | null, status?: string | null) {
  if (status !== "pending" || !updatedAt) return false;
  return Date.now() - new Date(updatedAt).getTime() < RECENT_PENDING_CHECKOUT_WINDOW_MS;
}

export async function POST(req: NextRequest) {
  try {
    const { userId: clerkUserId } = await auth();
    if (!clerkUserId) return apiError("Unauthorized", 401);

    if (!supabaseAdmin) return apiError("Database not configured", 500);

    let parsedBody: unknown;
    try {
      parsedBody = await req.json();
    } catch (error) {
      return apiError(
        "Invalid JSON body",
        400,
        {
          failureType: "billing_subscribe_invalid_json",
          errorName: error instanceof Error ? error.name : typeof error,
        },
        { reason: BILLING_SUBSCRIBE_REASON.INVALID_BODY }
      );
    }

    const parsedRequest = SubscribeRequestSchema.safeParse(parsedBody);
    if (!parsedRequest.success) {
      return apiError(
        "Invalid plan",
        400,
        parsedRequest.error,
        { reason: BILLING_SUBSCRIBE_REASON.INVALID_PLAN }
      );
    }

    const rawPlanKey = parsedRequest.data.plan;
    const planKey = rawPlanKey in PLANS ? (rawPlanKey as PlanKey) : null;
    const cadence: Cadence = parsedRequest.data.cadence;

    const ip = getIP(req);

    if (!planKey) {
      return apiError("Invalid plan", 400, undefined, {
        reason: BILLING_SUBSCRIBE_REASON.INVALID_PLAN,
      });
    }

    // Check if user already has a subscription record
    const { data: existingSub } = await supabaseAdmin
      .from("hermes_subscriptions")
      .select(
        "stripe_customer_id, stripe_subscription_id, plan, status, updated_at, signup_attribution"
      )
      .eq("user_id", clerkUserId)
      .maybeSingle();

    // Write-once first-touch attribution: persist only when the client sent a
    // stash AND the row doesn't already carry one. Otherwise the field is
    // omitted from every upsert payload so it can never be overwritten.
    const attributionToPersist =
      parsedRequest.data.attribution && !existingSub?.signup_attribution
        ? parsedRequest.data.attribution
        : null;

    // Live Stripe subscriptions must change through /api/billing/change-plan so
    // Stripe can prorate the existing subscription item. Manual/token-backed
    // paid rows have access but no live Stripe subscription to mutate, so they
    // are allowed to start Checkout and keep their current entitlement until
    // Checkout completes.
    const hasActivePaidSubscription =
      Boolean(existingSub && hasPlanAccessStatus(existingSub.status) && existingSub.plan !== "free");
    const shouldPreserveExistingEntitlement =
      Boolean(
        hasActivePaidSubscription &&
          typeof existingSub?.plan === "string" &&
          !isLiveStripeSubscriptionId(existingSub.stripe_subscription_id)
      );

    if (hasActivePaidSubscription && !shouldPreserveExistingEntitlement) {
      return apiError("You already have an active subscription.", 400, undefined, {
        reason: BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION,
      });
    }

    // Token/yearly-backed entitlement short-circuit. A holder whose $HERMESOS
    // holdings (or a yearly token sub) already grant a tier ≥ the plan they're
    // trying to buy has no reason to enter Stripe Checkout. This matters because
    // the get-started funnel auto-selects `operator` for a signed-in visitor and
    // would otherwise present a fleet-entitled holder a bill for compute they
    // already own — the exact dead-end a returning token holder hits from a
    // marketing link. resolveEffectiveSubscription maps the token tier to a plan
    // (pro→operator, power→fleet); when it covers the request, route them to the
    // dashboard just like an active subscription. A request for a STRICTLY higher
    // plan than the token tier (e.g. a Pro holder buying Fleet) still falls
    // through to real Checkout so genuine upgrades work.
    if (!hasActivePaidSubscription) {
      const tokenEntitlement = await resolveEffectiveSubscription(clerkUserId);
      const tokenBacked =
        tokenEntitlement?.source === "token_holding" ||
        tokenEntitlement?.source === "token_yearly";
      if (
        tokenBacked &&
        planRank(tokenEntitlement.plan as PlanKey) >= planRank(planKey)
      ) {
        return apiError("You already have an active subscription.", 400, undefined, {
          reason: BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION,
        });
      }
    }

    if (planKey === "free") {
      // Manual/token-backed paid rows pass the guard above so they can start
      // paid Checkout, but a free "activation" would silently downgrade them
      // (the activate page auto-POSTs plan=free on visit). Report the active
      // subscription instead — both frontends route this to the dashboard.
      if (hasActivePaidSubscription) {
        return apiError("You already have an active subscription.", 400, undefined, {
          reason: BILLING_SUBSCRIBE_REASON.ACTIVE_SUBSCRIPTION,
        });
      }

      const { error: freeActivationError } = await supabaseAdmin
        .from("hermes_subscriptions")
        .upsert(
          buildActiveFreeSubscriptionRecord({
            clerkUserId,
            stripeCustomerId: existingSub?.stripe_customer_id ?? null,
            attribution: attributionToPersist,
          }),
          { onConflict: "user_id" }
        );

      if (freeActivationError) {
        return apiError(
          "Failed to activate free plan",
          500,
          {
            failureType: "billing_subscribe_free_activation_failed",
            errorCode:
              typeof freeActivationError.code === "string"
                ? freeActivationError.code
                : undefined,
            detailsPresent: Boolean(freeActivationError.details),
            hintPresent: Boolean(freeActivationError.hint),
          }
        );
      }

      return apiSuccess({ activated: true, plan: "free" });
    }

    let stripePriceId: string;
    try {
      stripePriceId = getStripePriceId(planKey, cadence);
    } catch (configError) {
      return apiError(
        configError instanceof Error ? configError.message : "Stripe price not configured",
        500
      );
    }

    const stripe = getStripe();

    const hasRecentPendingCheckout = isRecentPendingCheckout(
      existingSub?.updated_at,
      existingSub?.status
    );

    // Get Clerk profile for customer creation and Stripe recovery
    const clerkUser = await currentUser();
    const email = clerkUser?.emailAddresses?.[0]?.emailAddress;
    const name = [clerkUser?.firstName, clerkUser?.lastName]
      .filter(Boolean)
      .join(" ")
      .trim();

    let stripeCustomerId = existingSub?.stripe_customer_id ?? null;

    if (existingSub) {
      const { customerId } = await validateOrRecreateStripeCustomer({
        customerId: stripeCustomerId,
        clerkUserId,
        email,
        name,
      });
      stripeCustomerId = customerId;

      if (
        shouldPreserveExistingEntitlement &&
        stripeCustomerId !== existingSub.stripe_customer_id
      ) {
        const { error: customerUpdateError } = await supabaseAdmin
          .from("hermes_subscriptions")
          .update({
            stripe_customer_id: stripeCustomerId,
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", clerkUserId);

        if (customerUpdateError) {
          return apiError(
            "Failed to prepare checkout",
            500,
            {
              failureType: "billing_subscribe_manual_customer_update_failed",
              errorCode:
                typeof customerUpdateError.code === "string"
                  ? customerUpdateError.code
                  : undefined,
              detailsPresent: Boolean(customerUpdateError.details),
              hintPresent: Boolean(customerUpdateError.hint),
            }
          );
        }
      }
    } else {
      // Create new Stripe customer
      const customer = await stripe.customers.create({
        email: email || undefined,
        name: name || undefined,
        metadata: { clerk_user_id: clerkUserId },
      });
      stripeCustomerId = customer.id;

      // Upsert subscription record
      const { error: persistNewCustomerError } = await supabaseAdmin
        .from("hermes_subscriptions")
        .upsert(
          buildPendingSubscriptionRecord({
            clerkUserId,
            stripeCustomerId: customer.id,
            planKey,
            attribution: attributionToPersist,
          }),
        { onConflict: "user_id" }
      );

      if (persistNewCustomerError) {
        return apiError(
          "Failed to prepare checkout",
          500,
          {
            failureType: "billing_subscribe_persist_customer_failed",
            errorCode:
              typeof persistNewCustomerError.code === "string"
                ? persistNewCustomerError.code
                : undefined,
            detailsPresent: Boolean(persistNewCustomerError.details),
            hintPresent: Boolean(persistNewCustomerError.hint),
          }
        );
      }
    }

    if (hasRecentPendingCheckout && stripeCustomerId) {
      try {
        const sessions = await stripe.checkout.sessions.list({
          customer: stripeCustomerId,
          limit: 10,
        });

        const openSessions = sessions.data.filter((session) => session.status === "open");
        const matchingSession = openSessions.find(
          (session) => session.url && session.metadata?.plan === planKey
        );

        if (matchingSession?.url) {
          return apiSuccess({ url: matchingSession.url, resumed: true });
        }

        const staleSessions = openSessions.filter(
          (session) => session.id !== matchingSession?.id
        );

        const expirationResults = await Promise.allSettled(
          staleSessions.map((session) => stripe.checkout.sessions.expire(session.id))
        );

        expirationResults.forEach((result, index) => {
          if (result.status === "rejected") {
            log.warn("failed to expire stale checkout session", {
              source: "billing-subscribe",
              route: "/api/billing/subscribe",
              method: "POST",
              userId: clerkUserId,
              sessionId: staleSessions[index]?.id,
              failureType: "billing_subscribe_expire_stale_session_failed",
              stripeErrorType:
                result.reason instanceof Stripe.errors.StripeError
                  ? result.reason.type
                  : undefined,
            }, result.reason);
          }
        });
      } catch (error) {
        return apiError(
          "A checkout session is already in progress. Please wait a moment and try again.",
          409,
          {
            failureType: "billing_subscribe_pending_checkout_recovery_failed",
            stripeErrorType:
              error instanceof Stripe.errors.StripeError ? error.type : undefined,
            stripeErrorCode:
              error instanceof Stripe.errors.StripeError ? error.code : undefined,
            errorName: error instanceof Error ? error.name : typeof error,
          },
          { reason: BILLING_SUBSCRIBE_REASON.CHECKOUT_IN_PROGRESS }
        );
      }
    }

    const appUrl = getDashboardOrigin();

    // Idempotency key scoped to the hour — prevents duplicate sessions
    // from double-clicks within the same checkout window
    // Cadence is part of the idempotency key so a user who first started
    // a monthly checkout and then switched to yearly within the same
    // hour gets a fresh session for the yearly price (vs. silently
    // re-using the monthly one).
    const idempotencyKey = `checkout_${clerkUserId}_${planKey}_${cadence}_${Math.floor(Date.now() / 3600000)}`;

    // 7-day Pro trial experiment (default-off scaffolding). Assignment is a
    // pure function of the user id, so this resolves to 0 trial days for
    // everyone until TRIAL_EXPERIMENT_ENABLED + TRIAL_EXPERIMENT_PERCENT are
    // set. Trial users get trial_period_days on the Checkout subscription;
    // the Stripe webhook already maps status 'trialing' → 'active'.
    const trialDays = getTrialDaysForUser(clerkUserId, planKey);

    const sessionMetadata = {
      user_id: clerkUserId,
      plan: planKey,
      cadence,
      checkout_ip: ip,
      ...(trialDays > 0 ? { trial_days: String(trialDays) } : {}),
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        payment_method_collection: "always",
        client_reference_id: clerkUserId,
        customer: stripeCustomerId,
        metadata: sessionMetadata,
        line_items: [{ price: stripePriceId, quantity: 1 }],
        subscription_data: {
          metadata: sessionMetadata,
          ...(trialDays > 0 ? { trial_period_days: trialDays } : {}),
        },
        // {CHECKOUT_SESSION_ID} is replaced by Stripe — used by confirm-checkout
        // to instantly activate the account without waiting for webhook delivery
        success_url: `${appUrl}/dashboard/billing?subscription=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/checkout/canceled?plan=${planKey}`,
        allow_promotion_codes: true,
      },
      { idempotencyKey }
    );

    // A/B assignment event — fires for BOTH buckets (control is the
    // baseline) the first time a user reaches a paid checkout while the
    // experiment is enabled. The stable $insert_id keeps PostHog from
    // counting repeat checkouts as new assignments. Observability only:
    // a capture/flush failure must never break checkout.
    if (isTrialExperimentEnabled()) {
      try {
        posthogClient.capture({
          distinctId: clerkUserId,
          event: "trial_experiment_assigned",
          properties: {
            bucket: bucketForUser(clerkUserId),
            plan: planKey,
            trial_days: trialDays,
            $insert_id: `trial_experiment_assigned_${clerkUserId}`,
          },
        });
        // Flush before the function dies — Vercel won't wait for async flushes.
        await posthogClient.flush();
      } catch (captureError) {
        log.warn("trial experiment assignment capture failed", {
          source: "billing-subscribe",
          route: "/api/billing/subscribe",
          method: "POST",
          userId: clerkUserId,
          failureType: "trial_experiment_capture_failed",
          errorName: captureError instanceof Error ? captureError.name : typeof captureError,
        });
      }
    }

    if (shouldPreserveExistingEntitlement) {
      log.info("manual paid subscription checkout started without mutating active entitlement", {
        source: "billing-subscribe",
        route: "/api/billing/subscribe",
        method: "POST",
        userId: clerkUserId,
        currentPlan: existingSub?.plan,
        targetPlan: planKey,
        sessionId: session.id,
        event: "billing_subscribe_manual_paid_checkout_started",
      });
    } else {
      const { error: pendingRefreshError } = await supabaseAdmin
        .from("hermes_subscriptions")
        .upsert(
          buildPendingSubscriptionRecord({
            clerkUserId,
            stripeCustomerId,
            planKey,
            attribution: attributionToPersist,
          }),
          { onConflict: "user_id" }
        );

      if (pendingRefreshError) {
        log.error("failed to refresh pending checkout state", new Error(pendingRefreshError.message || "billing_subscribe_pending_refresh_failed"), {
          source: "billing-subscribe",
          route: "/api/billing/subscribe",
          method: "POST",
          userId: clerkUserId,
          sessionId: session.id,
          failureType: "billing_subscribe_pending_refresh_failed",
          errorCode:
            typeof pendingRefreshError.code === "string"
              ? pendingRefreshError.code
              : undefined,
          detailsPresent: Boolean(pendingRefreshError.details),
          hintPresent: Boolean(pendingRefreshError.hint),
        });
      }
    }

    return apiSuccess({ url: session.url });
  } catch (error) {
    log.error("subscribe failed", error, {
      source: "billing-subscribe",
      route: "/api/billing/subscribe",
      method: "POST",
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "billing_subscribe_stripe_failed"
          : "billing_subscribe_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
    });

    const message =
      error instanceof Stripe.errors.StripeError
        ? "Unable to process subscription. Please try again or contact support."
        : "Failed to create checkout";
    return apiError(message, 500, {
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "billing_subscribe_stripe_failed"
          : "billing_subscribe_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
