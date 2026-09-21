import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";

import { apiError, apiSuccess } from "@/lib/api-response";
import {
  getCreditAccountStripeCustomerId,
  setCreditAccountStripeCustomerId,
} from "@/lib/billing/credits";
import { getStripe } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";

const MIN_MANAGED_VENICE_TOP_UP_MICRO_USD = 10_000_000;
const MAX_MANAGED_VENICE_TOP_UP_MICRO_USD = 5_000_000_000;

const ManagedVeniceCardTopUpRequestSchema = z.object({
  amountMicroUsd: z
    .number()
    .int()
    .min(MIN_MANAGED_VENICE_TOP_UP_MICRO_USD)
    .max(MAX_MANAGED_VENICE_TOP_UP_MICRO_USD),
});

function microUsdToCents(amountMicroUsd: number) {
  return Math.round(amountMicroUsd / 10_000);
}

function formatUsd(amountMicroUsd: number) {
  return `$${(amountMicroUsd / 1_000_000).toFixed(2)}`;
}

function getManagedVeniceCreditsProductId() {
  return process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID?.trim() || null;
}

function buildManagedVeniceLineItem(
  amountMicroUsd: number,
  amountCents: number
): Stripe.Checkout.SessionCreateParams.LineItem {
  const productId = getManagedVeniceCreditsProductId();
  const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
    currency: "usd",
    unit_amount: amountCents,
    ...(productId
      ? { product: productId }
      : {
          product_data: {
            name: `${formatUsd(amountMicroUsd)} managed Venice card credits`,
          },
        }),
  };

  return {
    price_data: priceData,
    quantity: 1,
  };
}

function buildManagedVeniceTopUpIdempotencyKey(
  userId: string,
  amountMicroUsd: number,
  nonce: string
): string {
  // A per-request nonce ensures two distinct intended same-amount top-ups never
  // collide on the same idempotency key (which previously bucketed on a 5-min
  // window and handed the second top-up a stale/expired Checkout URL). The key
  // is still stable across the Stripe SDK's internal network retries of a single
  // create call, so accidental duplicate sessions for one request are prevented.
  return `managed_venice_card_topup_${userId}_${amountMicroUsd}_${nonce}`;
}

export async function POST(req: NextRequest) {
  try {
    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "managed_venice_card_topup_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = ManagedVeniceCardTopUpRequestSchema.safeParse(body);
    if (!parsed.success) {
      return apiError("Invalid managed Venice card top-up amount", 400, {
        failureType: "managed_venice_card_topup_invalid_amount",
      });
    }

    const amountMicroUsd = parsed.data.amountMicroUsd;
    const amountCents = microUsdToCents(amountMicroUsd);
    const stripe = getStripe();
    let stripeCustomerId = await getCreditAccountStripeCustomerId(userId);

    if (!stripeCustomerId) {
      const clerkUser = await currentUser();
      const email = clerkUser?.emailAddresses?.[0]?.emailAddress;
      const name = [clerkUser?.firstName, clerkUser?.lastName]
        .filter(Boolean)
        .join(" ")
        .trim();

      const customer = await stripe.customers.create({
        email: email || undefined,
        name: name || undefined,
        metadata: { clerk_user_id: userId },
      });

      stripeCustomerId = customer.id;
      await setCreditAccountStripeCustomerId(userId, stripeCustomerId);
    }

    const appUrl = getDashboardOrigin();
    const metadata = {
      type: "managed_venice_card_topup",
      user_id: userId,
      wallet_type: "card",
      paid_micro_usd: String(amountMicroUsd),
      credit_micro_usd: String(amountMicroUsd),
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: stripeCustomerId,
        client_reference_id: userId,
        metadata,
        line_items: [buildManagedVeniceLineItem(amountMicroUsd, amountCents)],
        success_url: `${appUrl}/dashboard/billing?managedVenice=card_success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/dashboard/billing?managedVenice=card_canceled`,
      },
      {
        idempotencyKey: buildManagedVeniceTopUpIdempotencyKey(
          userId,
          amountMicroUsd,
          randomUUID()
        ),
      }
    );

    if (!session.url) {
      return apiError("Failed to start managed Venice card top-up", 500, {
        failureType: "managed_venice_card_topup_missing_checkout_url",
      });
    }

    return apiSuccess({ url: session.url });
  } catch (error) {
    return apiError("Failed to start managed Venice card top-up", 500, {
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "managed_venice_card_topup_stripe_failed"
          : "managed_venice_card_topup_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
