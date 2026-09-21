/**
 * Which subscription-management controls the billing page shows for a given
 * entitlement source. Extracted to a pure helper so the routing is unit-
 * testable without rendering the 2,000-line page component — and so the
 * Apple lane rule ("Apple subs are managed in the App Store, NEVER the
 * Stripe portal") lives in exactly one place.
 *
 * Existing behavior is preserved byte-for-byte for every non-Apple source:
 *  - the "Manage Subscription" (Stripe portal) button used to render
 *    unconditionally → still renders for every source except apple_iap;
 *  - the "Cancel subscription" link used to gate on
 *    `key !== "free" && (source === "stripe" || !source)` → unchanged.
 */

export const APPLE_MANAGE_SUBSCRIPTIONS_URL =
  "https://apps.apple.com/account/subscriptions";

export interface SubscriptionManagementView {
  /** Stripe billing-portal button ("Manage Subscription"). */
  showStripePortalButton: boolean;
  /** Stripe cancel-save-flow link ("Cancel subscription"). */
  showStripeCancelButton: boolean;
  /** "Manage in the App Store" link for Apple IAP subscribers. */
  showAppleManageLink: boolean;
  appleManageUrl: string;
}

export function resolveSubscriptionManagementView(params: {
  planKey: string | null | undefined;
  source: string | null | undefined;
}): SubscriptionManagementView {
  const { planKey, source } = params;
  const isApple = source === "apple_iap";

  return {
    showStripePortalButton: !isApple,
    // Unchanged legacy predicate: paid plan + Stripe (or legacy undefined)
    // source. apple_iap fails `source === "stripe" || !source` on its own,
    // but the explicit !isApple documents the invariant.
    showStripeCancelButton:
      !isApple && planKey !== "free" && (source === "stripe" || !source),
    showAppleManageLink: isApple,
    appleManageUrl: APPLE_MANAGE_SUBSCRIPTIONS_URL,
  };
}
