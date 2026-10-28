import { currentUser } from "@clerk/nextjs/server";
import type Stripe from "stripe";
import {
  getCreditAccountStripeCustomerId,
  setCreditAccountStripeCustomerId,
} from "@/lib/billing/credits";

/**
 * The Stripe customer that owns a person's credit account, created on first
 * top-up. A concurrent first top-up may create its own customer; the conditional
 * claim keeps whichever is stored first and both callers use that id.
 */
export async function getOrCreateCreditStripeCustomerId(
  userId: string,
  stripe: Stripe
): Promise<string> {
  const existing = await getCreditAccountStripeCustomerId(userId);
  if (existing) return existing;

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

  return setCreditAccountStripeCustomerId(userId, customer.id);
}
