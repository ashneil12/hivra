import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";
import Stripe from "stripe";
import { z } from "zod";
import { apiError, apiSuccess } from "@/lib/api-response";
import {
  BILLING_V2_UNAVAILABLE_MESSAGE,
  CREDIT_TOPUPS_UNAVAILABLE_MESSAGE,
  isCreditTopUpsServerEnabled,
  isBillingV2ServerEnabled,
} from "@/lib/billing/billing-v2-availability";
import {
  creditsToUsd,
  getCreditAccountStripeCustomerId,
  isTopUpPackageCredits,
  setCreditAccountStripeCustomerId,
} from "@/lib/billing/credits";
import { getStripe } from "@/lib/stripe";
import { getDashboardOrigin } from "@/lib/venice/managed-endpoints";

const TopUpRequestSchema = z.object({
  packageCredits: z.number().int().positive(),
});

function buildTopUpIdempotencyKey(
  userId: string,
  packageCredits: number,
  nonce: string
): string {
  // A per-request nonce ensures two distinct intended same-package top-ups never
  // collide on the same idempotency key (which previously bucketed on a 5-min
  // window and would hand the second top-up the first session's stale URL). The
  // key is still stable across the Stripe SDK's internal network retries of a
  // single create call, so accidental duplicate sessions for one request are
  // still prevented.
  return `credit_topup_${userId}_${packageCredits}_${nonce}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!isBillingV2ServerEnabled()) {
      return apiError(BILLING_V2_UNAVAILABLE_MESSAGE, 404);
    }

    if (!isCreditTopUpsServerEnabled()) {
      return apiError(CREDIT_TOPUPS_UNAVAILABLE_MESSAGE, 404, {
        failureType: "billing_topup_feature_disabled",
      });
    }

    const { userId } = await auth();
    if (!userId) return apiError("Unauthorized", 401);

    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      return apiError("Invalid JSON body", 400, {
        failureType: "billing_topup_invalid_json",
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }

    const parsed = TopUpRequestSchema.safeParse(body);
    if (!parsed.success || !isTopUpPackageCredits(parsed.data.packageCredits)) {
      return apiError("Invalid credit top-up package", 400);
    }

    const packageCredits = parsed.data.packageCredits;
    const packageUsd = creditsToUsd(packageCredits);
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
      type: "credit_topup",
      user_id: userId,
      package_credits: String(packageCredits),
      package_usd: String(packageUsd),
    };

    const session = await stripe.checkout.sessions.create(
      {
        mode: "payment",
        customer: stripeCustomerId,
        client_reference_id: userId,
        metadata,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `${packageCredits.toLocaleString()} Hivra credits`,
              },
              // Stripe unit_amount is in cents. Derive it from the USD price
              // (packageUsd = creditsToUsd(packageCredits)) rather than passing
              // the raw credit count. They coincide today only because the
              // current packages are priced at 1 credit = 1 cent; deriving from
              // USD keeps the charge correct if either the packages or the
              // credits-to-USD rate ever change.
              unit_amount: Math.round(packageUsd * 100),
            },
            quantity: 1,
          },
        ],
        success_url: `${appUrl}/dashboard/billing?credits=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/dashboard/billing?credits=canceled`,
      },
      {
        idempotencyKey: buildTopUpIdempotencyKey(userId, packageCredits, randomUUID()),
      }
    );

    if (!session.url) {
      return apiError("Failed to start credit top-up", 500, {
        failureType: "billing_topup_missing_checkout_url",
      });
    }

    return apiSuccess({ url: session.url });
  } catch (error) {
    return apiError("Failed to start credit top-up", 500, {
      failureType:
        error instanceof Stripe.errors.StripeError
          ? "billing_topup_stripe_failed"
          : "billing_topup_unexpected_error",
      stripeErrorType: error instanceof Stripe.errors.StripeError ? error.type : undefined,
      stripeErrorCode: error instanceof Stripe.errors.StripeError ? error.code : undefined,
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
