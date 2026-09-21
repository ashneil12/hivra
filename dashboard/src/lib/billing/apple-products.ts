/**
 * Apple IAP product configuration — the ONE place App Store product ids map
 * to platform plan keys.
 *
 * Product ids default to the launch naming convention but are env-overridable
 * so App Store Connect renames never require a code change (ASC products
 * can be removed from sale but never deleted, so ids must be settable).
 *
 * Env (see dashboard/README-APPLE-IAP.md for the full deploy-time list):
 *   APPLE_BUNDLE_ID                 app bundle id (default cloud.hivra.app)
 *   APPLE_ENVIRONMENT               "Production" (default) | "Sandbox"
 *   APPLE_PRODUCT_ID_PRO_MONTHLY    default cloud.hivra.pro.monthly   -> operator
 *   APPLE_PRODUCT_ID_PRO_YEARLY     default cloud.hivra.pro.yearly    -> operator
 *   APPLE_PRODUCT_ID_POWER_MONTHLY  default cloud.hivra.power.monthly -> fleet
 *   APPLE_PRODUCT_ID_POWER_YEARLY   default cloud.hivra.power.yearly  -> fleet
 *
 * All accessors read process.env at call time (the isBillingLegacyHardDelete
 * convention) so tests and runtime flag flips need no module reload.
 */

import type { PlanKey } from "@/lib/subscription";

export type AppleEnvironment = "Sandbox" | "Production";

interface AppleProductMapping {
  productId: string;
  plan: PlanKey;
  cadence: "monthly" | "yearly";
}

/** Apple subscription statuses that grant access in the entitlement resolver. */
export const APPLE_ACCESS_STATUSES = [
  "active",
  "trialing",
  "grace_period",
] as const;

/** Row statuses the reconciler treats as "worth converging" (non-terminal). */
export const APPLE_NON_TERMINAL_STATUSES = [
  "active",
  "trialing",
  "grace_period",
  "past_due",
] as const;

export type AppleSubscriptionStatus =
  | "active"
  | "trialing"
  | "grace_period"
  | "past_due"
  | "expired"
  | "revoked";

export function getAppleBundleId(): string {
  return process.env.APPLE_BUNDLE_ID?.trim() || "cloud.hivra.app";
}

export function getAppleEnvironment(): AppleEnvironment {
  return process.env.APPLE_ENVIRONMENT?.trim().toLowerCase() === "sandbox"
    ? "Sandbox"
    : "Production";
}

/**
 * Whether a notification signed for the OTHER environment should be accepted
 * after the primary verifier rejects it. Apple posts sandbox-signed
 * notifications (e.g. TestFlight, review-team purchases) to whichever URL is
 * configured; without this a prod deploy can't run a sandbox end-to-end test.
 * Default off in production, on otherwise.
 */
export function appleSandboxFallbackEnabled(): boolean {
  const flag = process.env.APPLE_ACCEPT_SANDBOX_NOTIFICATIONS?.trim().toLowerCase();
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function getAppleProductMappings(): AppleProductMapping[] {
  return [
    {
      productId:
        process.env.APPLE_PRODUCT_ID_PRO_MONTHLY?.trim() || "cloud.hivra.pro.monthly",
      plan: "operator",
      cadence: "monthly",
    },
    {
      productId:
        process.env.APPLE_PRODUCT_ID_PRO_YEARLY?.trim() || "cloud.hivra.pro.yearly",
      plan: "operator",
      cadence: "yearly",
    },
    {
      productId:
        process.env.APPLE_PRODUCT_ID_POWER_MONTHLY?.trim() ||
        "cloud.hivra.power.monthly",
      plan: "fleet",
      cadence: "monthly",
    },
    {
      productId:
        process.env.APPLE_PRODUCT_ID_POWER_YEARLY?.trim() ||
        "cloud.hivra.power.yearly",
      plan: "fleet",
      cadence: "yearly",
    },
  ];
}

/**
 * Map an App Store product id to its platform plan key, or null when the
 * product is unknown (never guess a plan for an unrecognized product — the
 * webhook refuses the event loudly instead).
 */
export function planFromAppleProductId(productId: string | null | undefined): PlanKey | null {
  if (!productId) return null;
  const match = getAppleProductMappings().find((m) => m.productId === productId);
  return match ? match.plan : null;
}
