import { NextRequest } from "next/server";
import Stripe from "stripe";
import { apiSuccess, apiError } from "@/lib/api-response";
import { getStripe } from "@/lib/stripe";
import { log } from "@/lib/logger";
import { enforceRateLimit, getIP } from "@/lib/rate-limit";
import { StripeWebhookService } from "@/lib/services/stripe-webhook-service";
import {
  handleWorkspaceCloudCheckoutCompleted,
  handleWorkspaceCloudSubscriptionChange,
  handleWorkspaceCloudSubscriptionDeleted,
  isWorkspaceCloudCheckout,
  isWorkspaceCloudSubscription,
} from "@/lib/services/workspace-cloud-billing-service";
import {
  beginStripeWebhookEvent,
  markStripeWebhookEventFailed,
  markStripeWebhookEventProcessed,
} from "@/lib/stripe-webhook-events";
import {
  findOtherUserWithSatisfiedFingerprint,
  markCardOnFile,
  markCardRejected,
} from "@/lib/abuse/repository";

// SCRIPTURE_ANCHOR: stripe-steward | Luke 16:10 | Verse: He who is faithful in a very little is faithful also in much.
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || null;

export async function POST(req: NextRequest) {
  try {
    const ip = getIP(req);
    const { success } = enforceRateLimit(`stripe_webhook_${ip}`, {
      limit: 50,
      windowMs: 60 * 1000,
    });
    
    if (!success) {
      return apiError("Too Many Requests", 429);
    }

    const body = await req.text();
    const signature = req.headers.get("stripe-signature");

    if (!webhookSecret) {
      log.error(
        "STRIPE_WEBHOOK_SECRET is not configured — rejecting",
        new Error("STRIPE_WEBHOOK_SECRET missing"),
        {
          source: "stripe-webhook",
          route: "/api/webhooks/stripe",
          method: "POST",
          failureType: "stripe_webhook_misconfigured",
        },
      );
      return apiError("Webhook not configured", 500);
    }
    if (!signature) {
      return apiError("Missing signature", 400);
    }

    let event: Stripe.Event;
    try {
      const stripe = getStripe();
      event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
    } catch (err) {
      return apiError("Invalid signature", 400, {
        failureType: "stripe_webhook_invalid_signature",
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }

    const reservation = await beginStripeWebhookEvent(event.id, event.type);
    if (reservation === "duplicate" || reservation === "processing") {
      return apiSuccess({ received: true, duplicate: true });
    }
    if (reservation === "untracked" && process.env.NODE_ENV === "production") {
      // Stripe redelivers any non-2xx response. Without the idempotency
      // table, every retry would re-grant credits, double-charge trial
      // usage, double-fire analytics. Refuse to process in prod so the
      // misconfig surfaces immediately instead of silently double-paying.
      // Dev/test envs intentionally allow "untracked" so local Stripe
      // testing works without supabase running.
      log.error(
        "stripe_webhook_events table or service role missing in production; refusing to process without idempotency",
        new Error("stripe_webhook_untracked_in_prod"),
        {
          source: "stripe-webhook",
          route: "/api/webhooks/stripe",
          method: "POST",
          failureType: "stripe_webhook_untracked_in_prod",
          eventId: event.id,
          eventType: event.type,
        },
      );
      return apiError("Webhook idempotency not configured", 503);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const session = event.data.object as Stripe.Checkout.Session;
          // Workspace Cloud lane purchases route to the lane's own table; the
          // Hivra path never sees them.
          if (isWorkspaceCloudCheckout(session)) {
            await handleWorkspaceCloudCheckoutCompleted(session);
          } else {
            await StripeWebhookService.handleCheckoutCompleted(session);
          }
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscription = event.data.object as Stripe.Subscription;
          if (isWorkspaceCloudSubscription(subscription)) {
            await handleWorkspaceCloudSubscriptionChange(subscription);
          } else {
            await StripeWebhookService.handleSubscriptionChange(subscription);
          }
          break;
        }
        case "customer.subscription.deleted": {
          const subscription = event.data.object as Stripe.Subscription;
          if (isWorkspaceCloudSubscription(subscription)) {
            await handleWorkspaceCloudSubscriptionDeleted(subscription);
          } else {
            await StripeWebhookService.handleSubscriptionDeleted(subscription);
          }
          break;
        }
        // An invoice carries no lane marker; the handlers retrieve the live
        // subscription, send Workspace Cloud ones to that lane, and touch the
        // Hivra row only when it is bound to that exact subscription.
        case "invoice.paid":
          await StripeWebhookService.handleInvoicePaid(event.data.object as Stripe.Invoice);
          break;
        case "invoice.payment_failed":
          await StripeWebhookService.handlePaymentFailed(event.data.object as Stripe.Invoice);
          break;
        case "setup_intent.succeeded":
          await handleSetupIntentSucceeded(event.data.object as Stripe.SetupIntent);
          break;
        default:
          break;
      }
      await markStripeWebhookEventProcessed(event.id);
    } catch (error) {
      await markStripeWebhookEventFailed(event.id, error);
      throw error;
    }

    return apiSuccess({ received: true });
  } catch (error) {
    return apiError("Webhook handler failed", 500, {
      failureType: "stripe_webhook_handler_failed",
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/**
 * Handle setup_intent.succeeded — this fires when a user completes the
 * card-on-file collection flow gated by the free-tier abuse check.
 *
 * Steps:
 *   1. Pull clerk_user_id out of intent.metadata (set by /api/billing/setup-intent)
 *   2. Pull payment_method id out of the SetupIntent and retrieve the full
 *      PaymentMethod from Stripe so we can read card.funding + card.fingerprint
 *   3. Reject prepaid cards (virtual-card services like Privacy.com)
 *   4. Reject fingerprint collisions (same physical card already cleared
 *      the gate on another account)
 *   5. Otherwise flip card_satisfied_at + decision="allow" on the user's
 *      risk assessment row, unblocking their next provisioning attempt
 *
 * Silently no-ops (with a warning log) if metadata.clerk_user_id is
 * missing — that means the SetupIntent was created outside our flow
 * (manual Stripe dashboard, legacy code path, etc) and we don't know who
 * to attribute the card to.
 */
async function handleSetupIntentSucceeded(intent: Stripe.SetupIntent): Promise<void> {
  const clerkUserId = intent.metadata?.clerk_user_id;
  if (!clerkUserId) {
    log.warn("setup_intent.succeeded missing clerk_user_id metadata", {
      source: "stripe-webhook",
      failureType: "setup_intent_missing_metadata",
      setupIntentId: intent.id,
    });
    return;
  }

  // payment_method on a succeeded SetupIntent is always populated. Stripe
  // types it as string | PaymentMethod | null because it's optional during
  // intent creation; on success it's the attached PM id (string).
  const paymentMethodId =
    typeof intent.payment_method === "string"
      ? intent.payment_method
      : intent.payment_method?.id;

  if (!paymentMethodId) {
    log.warn("setup_intent.succeeded missing payment_method", {
      source: "stripe-webhook",
      failureType: "setup_intent_missing_pm",
      setupIntentId: intent.id,
      clerkUserId,
    });
    return;
  }

  // Retrieve the full PaymentMethod so we can read card.funding +
  // card.fingerprint. The webhook payload only carries the id. This is
  // the abuse gate's only signal — if retrieval fails we MUST fail
  // closed (don't mark the card on file with null fingerprint),
  // otherwise an attacker who can force a transient retrieve failure
  // (e.g. Stripe outage, or by submitting a card whose detail fetch
  // fails) clears the gate without ever exposing a fingerprint and can
  // repeat from each fresh account. Stripe will redeliver this webhook
  // — so missed-once on a real outage is fine, the next delivery will
  // succeed and the card will be evaluated then.
  let cardFingerprint: string | null = null;
  let cardFunding: string | null = null;
  try {
    const stripe = getStripe();
    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    cardFingerprint = pm.card?.fingerprint ?? null;
    cardFunding = pm.card?.funding ?? null;
  } catch (err) {
    log.warn("paymentMethods.retrieve failed during setup_intent.succeeded; failing closed for redelivery", {
      source: "stripe-webhook",
      failureType: "payment_method_retrieve_failed",
      setupIntentId: intent.id,
      paymentMethodId,
      clerkUserId,
      errorName: err instanceof Error ? err.name : typeof err,
    });
    // Throwing here makes Stripe retry the webhook; the retrieve is
    // typically idempotent and will succeed on the next delivery. No
    // markCardOnFile happens, so the abuse gate stays closed in the
    // meantime.
    throw err;
  }
  if (!cardFingerprint || !cardFunding) {
    log.warn("paymentMethods.retrieve returned without fingerprint/funding; failing closed", {
      source: "stripe-webhook",
      failureType: "payment_method_retrieve_incomplete",
      setupIntentId: intent.id,
      paymentMethodId,
      clerkUserId,
      hasFingerprint: Boolean(cardFingerprint),
      hasFunding: Boolean(cardFunding),
    });
    // A response that's missing both signals is structurally unusable
    // for the abuse gate. Don't mark on file. Don't throw — Stripe
    // re-retrying won't change a malformed response, and we don't want
    // an infinite redelivery loop. The user will see "card not yet
    // validated" until they submit a working card.
    return;
  }

  // Reject 1: prepaid cards. Virtual-card services (Privacy.com, Lithic,
  // Revolut Disposable, etc.) issue prepaid BINs, so this catches the
  // bulk of "different card, same person" abuse without needing a BIN
  // allowlist. Stripe's funding field is normalized across networks.
  if (cardFunding === "prepaid") {
    await markCardRejected({
      userId: clerkUserId,
      setupIntentId: intent.id,
      paymentMethodId,
      cardFingerprint,
      cardFunding,
      reason: "prepaid_card",
    });
    log.warn("rejected prepaid card on setup_intent.succeeded", {
      source: "stripe-webhook",
      failureType: "card_rejected_prepaid",
      userId: clerkUserId,
      setupIntentId: intent.id,
      paymentMethodId,
      cardFingerprint,
    });
    return;
  }

  // Reject 2: fingerprint collision. Same physical card, different
  // account. We only count OTHER users who have card_satisfied_at set —
  // a prior rejected attempt on the same card doesn't count as a
  // "successful claim" worth defending.
  if (cardFingerprint) {
    const colliding = await findOtherUserWithSatisfiedFingerprint(
      cardFingerprint,
      clerkUserId
    );
    if (colliding) {
      await markCardRejected({
        userId: clerkUserId,
        setupIntentId: intent.id,
        paymentMethodId,
        cardFingerprint,
        cardFunding,
        reason: "card_collision",
      });
      log.warn("rejected card collision on setup_intent.succeeded", {
        source: "stripe-webhook",
        failureType: "card_rejected_collision",
        userId: clerkUserId,
        setupIntentId: intent.id,
        paymentMethodId,
        cardFingerprint,
        collidingUserId: colliding,
      });
      return;
    }
  }

  await markCardOnFile({
    userId: clerkUserId,
    setupIntentId: intent.id,
    paymentMethodId,
    cardFingerprint,
    cardFunding,
  });

  log.info("card on file recorded via setup_intent.succeeded", {
    source: "stripe-webhook",
    userId: clerkUserId,
    setupIntentId: intent.id,
    paymentMethodId,
    cardFunding,
  });
}
