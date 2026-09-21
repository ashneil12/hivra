import {
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  resolveSubscriptionManagementView,
} from "@/lib/billing/subscription-management-copy";

describe("resolveSubscriptionManagementView", () => {
  // Characterization of the pre-Apple behavior: for every existing source the
  // controls must match what the billing page rendered before the change —
  // portal button always, cancel link only for paid Stripe/legacy-undefined.
  describe("existing sources keep their exact pre-Apple controls", () => {
    it("paid Stripe: portal + cancel, no App Store link", () => {
      const view = resolveSubscriptionManagementView({
        planKey: "operator",
        source: "stripe",
      });
      expect(view).toEqual({
        showStripePortalButton: true,
        showStripeCancelButton: true,
        showAppleManageLink: false,
        appleManageUrl: APPLE_MANAGE_SUBSCRIPTIONS_URL,
      });
    });

    it("legacy row without a source behaves like Stripe (pre-existing fallback)", () => {
      const view = resolveSubscriptionManagementView({
        planKey: "fleet",
        source: undefined,
      });
      expect(view.showStripePortalButton).toBe(true);
      expect(view.showStripeCancelButton).toBe(true);
      expect(view.showAppleManageLink).toBe(false);
    });

    it("free plan: portal but no cancel link", () => {
      const view = resolveSubscriptionManagementView({
        planKey: "free",
        source: "free",
      });
      expect(view.showStripePortalButton).toBe(true);
      expect(view.showStripeCancelButton).toBe(false);
      expect(view.showAppleManageLink).toBe(false);
    });

    it.each(["token_holding", "token_yearly", "workspace_cloud"] as const)(
      "%s: portal but no cancel link (cancellation is not Stripe's)",
      (source) => {
        const view = resolveSubscriptionManagementView({
          planKey: "operator",
          source,
        });
        expect(view.showStripePortalButton).toBe(true);
        expect(view.showStripeCancelButton).toBe(false);
        expect(view.showAppleManageLink).toBe(false);
      }
    );
  });

  describe("apple_iap routes management to the App Store, never Stripe", () => {
    it("shows only the App Store link", () => {
      const view = resolveSubscriptionManagementView({
        planKey: "operator",
        source: "apple_iap",
      });
      expect(view).toEqual({
        showStripePortalButton: false,
        showStripeCancelButton: false,
        showAppleManageLink: true,
        appleManageUrl: "https://apps.apple.com/account/subscriptions",
      });
    });

    it("holds for the power plan too", () => {
      const view = resolveSubscriptionManagementView({
        planKey: "fleet",
        source: "apple_iap",
      });
      expect(view.showStripePortalButton).toBe(false);
      expect(view.showStripeCancelButton).toBe(false);
      expect(view.showAppleManageLink).toBe(true);
    });
  });
});
