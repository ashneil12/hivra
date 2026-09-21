import Stripe from "stripe";
import { supabaseAdmin } from "@/lib/supabase";
import { log } from "@/lib/logger";

// SCRIPTURE_ANCHOR: stripe-faithful | Proverbs 21:5 | Verse: The plans of the diligent surely lead to profit; and everyone who is hasty surely rushes to poverty.
const LOG_SOURCE = "stripe";

const STRIPE_API_VERSION = "2026-03-25.dahlia";

/**
 * Lazily initialize Stripe to prevent crashes during Next.js build-time
 * page data collection when STRIPE_SECRET_KEY is not available.
 */
let _stripe: Stripe | null = null;
export function getStripe(): Stripe {
  if (!_stripe) {
    const secretKey = process.env.STRIPE_SECRET_KEY;
    if (!secretKey) {
      throw new Error(
        "STRIPE_SECRET_KEY environment variable is not set. " +
          "Stripe billing features will not work until this is configured."
      );
    }
    _stripe = new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION as Stripe.LatestApiVersion,
      // Retry transient Stripe failures (429 rate-limit, 5xx, network) with
      // backoff. Default is 0, which surfaced single-blip 429/5xx as
      // subscription-state-reconciler row errors (2026-06-09 incident).
      maxNetworkRetries: 2,
    });
  }
  return _stripe;
}

// ── Stripe Customer Validation ───────────────────────────────────────────────

interface ValidateCustomerOptions {
  customerId?: string | null;
  clerkUserId: string;
  email?: string;
  name?: string;
}

interface ValidateCustomerResult {
  customerId: string;
  wasRecreated: boolean;
}

/**
 * If the customer's `metadata.clerk_user_id` is set, it MUST match the
 * caller's clerk user id. A mismatch means the row is bound to a different
 * Clerk account and we must not allow the current caller to drive billing
 * against it (cross-account customer reuse / abuse-gate bypass). When the
 * field is absent (legacy data created before metadata was tagged) we
 * backfill it with the current user — this is best-effort recovery, not
 * a security gate.
 */
function ensureCustomerOwnership(
  customer: Stripe.Customer,
  clerkUserId: string,
  stripe: Stripe
): "ok" | "mismatch" {
  const metadataUserId = customer.metadata?.clerk_user_id;
  if (typeof metadataUserId === "string" && metadataUserId.trim()) {
    if (metadataUserId.trim() !== clerkUserId) {
      return "mismatch";
    }
    return "ok";
  }
  // Legacy customer with no metadata. Backfill so future calls are safe.
  log.warn("backfilling clerk_user_id on legacy stripe customer", {
    source: LOG_SOURCE,
    failureType: "stripe_customer_metadata_backfill",
    userId: clerkUserId,
    customerId: customer.id,
  });
  void stripe.customers
    .update(customer.id, { metadata: { ...customer.metadata, clerk_user_id: clerkUserId } })
    .catch((err) => {
      log.error("failed to backfill clerk_user_id on stripe customer", err, {
        source: LOG_SOURCE,
        failureType: "stripe_customer_metadata_backfill_failed",
        userId: clerkUserId,
        customerId: customer.id,
      });
    });
  return "ok";
}

/**
 * Validates that a stored Stripe customer ID still exists, is not deleted,
 * and is bound to the same Clerk user via `metadata.clerk_user_id`. If
 * missing, deleted, or owned by a different user, creates a new one and
 * updates hermes_subscriptions.
 */
export async function validateOrRecreateStripeCustomer(
  opts: ValidateCustomerOptions
): Promise<ValidateCustomerResult> {
  const stripe = getStripe();

  // If no customer ID was stored, try looking them up by email or create a new one.
  if (!opts.customerId) {
    if (opts.email) {
      const customers = await stripe.customers.list({
        email: opts.email,
        limit: 1,
      });

      if (customers.data.length > 0) {
        const found = customers.data[0];
        const foundId = found.id;
        const ownership = ensureCustomerOwnership(found, opts.clerkUserId, stripe);
        if (ownership === "mismatch") {
          log.warn("rejecting email-matched stripe customer owned by another clerk user", {
            source: LOG_SOURCE,
            failureType: "stripe_customer_email_match_owner_mismatch",
            userId: opts.clerkUserId,
            customerId: foundId,
          });
          // Don't link this caller to a customer owned by someone else.
          return await recreateCustomer(stripe, { ...opts, customerId: "" });
        }
        log.info("found existing customer by email", {
          source: LOG_SOURCE,
          userId: opts.clerkUserId,
          customerId: foundId,
        });

        if (supabaseAdmin) {
          const { error: updateError } = await supabaseAdmin
            .from("hermes_subscriptions")
            .update({ stripe_customer_id: foundId })
            .eq("user_id", opts.clerkUserId);

          if (updateError) {
            log.error("failed to update hermes_subscriptions with found customer ID", updateError, {
              source: LOG_SOURCE,
              failureType: "subscription_update_found_customer_failed",
              userId: opts.clerkUserId,
              customerId: foundId,
              errorCode: updateError.code,
            });
          }
        }
        return { customerId: foundId, wasRecreated: false };
      }
    }
    return await recreateCustomer(stripe, { ...opts, customerId: "" });
  }

  try {
    const customer = await stripe.customers.retrieve(opts.customerId);

    if ("deleted" in customer && customer.deleted) {
      log.warn("customer is deleted, recreating", {
        source: LOG_SOURCE,
        failureType: "customer_deleted_recreate",
        userId: opts.clerkUserId,
        customerId: opts.customerId,
      });
      return await recreateCustomer(stripe, opts);
    }

    const ownership = ensureCustomerOwnership(customer, opts.clerkUserId, stripe);
    if (ownership === "mismatch") {
      log.warn("stored stripe customer owner mismatch — recreating", {
        source: LOG_SOURCE,
        failureType: "stripe_customer_owner_mismatch_recreate",
        userId: opts.clerkUserId,
        customerId: opts.customerId,
      });
      return await recreateCustomer(stripe, opts);
    }

    return { customerId: opts.customerId, wasRecreated: false };
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === "resource_missing"
    ) {
      log.warn("customer not found, recreating", {
        source: LOG_SOURCE,
        failureType: "customer_not_found_recreate",
        userId: opts.clerkUserId,
        customerId: opts.customerId,
      });
      return await recreateCustomer(stripe, opts);
    }
    throw error;
  }
}

async function recreateCustomer(
  stripe: Stripe,
  opts: ValidateCustomerOptions
): Promise<ValidateCustomerResult> {
  const newCustomer = await stripe.customers.create({
    email: opts.email || undefined,
    name: opts.name || undefined,
    metadata: {
      clerk_user_id: opts.clerkUserId,
      recreated_from: opts.customerId || null,
    },
  });

  log.info("recreated customer", {
    source: LOG_SOURCE,
    userId: opts.clerkUserId,
    previousCustomerId: opts.customerId,
    customerId: newCustomer.id,
  });

  if (supabaseAdmin) {
    const { error: updateError } = await supabaseAdmin
      .from("hermes_subscriptions")
      .update({ stripe_customer_id: newCustomer.id })
      .eq("user_id", opts.clerkUserId);

    if (updateError) {
      log.error("failed to update hermes_subscriptions with new customer ID", updateError, {
        source: LOG_SOURCE,
        failureType: "subscription_update_new_customer_failed",
        userId: opts.clerkUserId,
        customerId: newCustomer.id,
        errorCode: updateError.code,
      });
    }
  }

  return { customerId: newCustomer.id, wasRecreated: true };
}
