import type Stripe from "stripe";

import {
  isWorkspaceCloudCheckout,
  isWorkspaceCloudSubscription,
  handleWorkspaceCloudSubscriptionChange,
  handleWorkspaceCloudSubscriptionDeleted,
} from "@/lib/services/workspace-cloud-billing-service";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

function makeSubscription(overrides: Partial<Stripe.Subscription> = {}): Stripe.Subscription {
  return {
    id: "sub_123",
    status: "active",
    customer: "cus_123",
    metadata: { surface: "workspace_cloud", user_id: "user_abc", plan: "ws_cloud_pro" },
    items: {
      data: [
        {
          price: { id: "price_lane_pro" },
          current_period_end: 1893456000, // 2030-01-01
        },
      ],
    },
    ...overrides,
  } as unknown as Stripe.Subscription;
}

describe("workspace-cloud-billing-service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  describe("lane detection", () => {
    it("routes a checkout session tagged surface=workspace_cloud to the lane", () => {
      expect(
        isWorkspaceCloudCheckout({ metadata: { surface: "workspace_cloud" } } as unknown as Stripe.Checkout.Session)
      ).toBe(true);
    });

    it("leaves Hivra checkouts (no lane surface) for the existing path", () => {
      expect(
        isWorkspaceCloudCheckout({ metadata: { plan: "operator" } } as unknown as Stripe.Checkout.Session)
      ).toBe(false);
    });

    it("detects a lane subscription via metadata.surface", () => {
      expect(isWorkspaceCloudSubscription(makeSubscription())).toBe(true);
    });

    it("does not treat a Hivra subscription as a lane subscription", () => {
      const sub = makeSubscription({ metadata: { user_id: "u" } as Stripe.Metadata });
      // No lane surface and no lane price id → Hivra path.
      expect(isWorkspaceCloudSubscription(sub)).toBe(false);
    });

    it("ignores the price ID — a regular Pro sub is never classified as lane", () => {
      // Regression: lane plans default to the SAME Stripe price IDs as Hivra
      // (operator/fleet), so a regular Hivra Pro sub (no surface metadata)
      // must NOT be read as Workspace Cloud. Classification is metadata-only;
      // the price ID — even one that also belongs to a lane plan — is ignored.
      const regularPro = makeSubscription({
        metadata: { user_id: "u", plan: "operator" } as Stripe.Metadata,
      });
      expect(isWorkspaceCloudSubscription(regularPro)).toBe(false);
    });
  });

  describe("handleWorkspaceCloudSubscriptionChange", () => {
    it("upserts the lane plan's budgets into workspace_cloud_subscriptions", async () => {
      const upsert = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({ upsert });

      await handleWorkspaceCloudSubscriptionChange(
        makeSubscription({ metadata: { surface: "workspace_cloud", user_id: "user_abc", plan: "ws_cloud_power" } as Stripe.Metadata })
      );

      expect(supabaseAdmin!.from).toHaveBeenCalledWith("workspace_cloud_subscriptions");
      const [payload, opts] = upsert.mock.calls[0];
      expect(payload).toMatchObject({
        user_id: "user_abc",
        plan: "ws_cloud_power",
        status: "active",
        stripe_subscription_id: "sub_123",
        stripe_customer_id: "cus_123",
        // Power mirrors Hivra fleet: 4 vCPU / 8192 MB.
        total_cpu_budget: 4,
        total_ram_budget: 8192,
      });
      expect(opts).toEqual({ onConflict: "user_id" });
    });

    it("maps non-entitling Stripe statuses to canceled", async () => {
      const upsert = jest.fn().mockResolvedValue({ error: null });
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({ upsert });

      await handleWorkspaceCloudSubscriptionChange(
        makeSubscription({ status: "incomplete_expired" })
      );

      expect(upsert.mock.calls[0][0]).toMatchObject({ status: "canceled" });
    });

    it("no-ops (no write) when user_id metadata is missing", async () => {
      const upsert = jest.fn();
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({ upsert });

      await handleWorkspaceCloudSubscriptionChange(
        makeSubscription({ metadata: { surface: "workspace_cloud" } as Stripe.Metadata })
      );

      expect(upsert).not.toHaveBeenCalled();
    });
  });

  describe("handleWorkspaceCloudSubscriptionDeleted", () => {
    it("marks the lane subscription canceled by stripe_subscription_id", async () => {
      const eq = jest.fn().mockResolvedValue({ error: null });
      const update = jest.fn().mockReturnValue({ eq });
      (supabaseAdmin!.from as jest.Mock).mockReturnValue({ update });

      await handleWorkspaceCloudSubscriptionDeleted(makeSubscription());

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({ status: "canceled" })
      );
      expect(eq).toHaveBeenCalledWith("stripe_subscription_id", "sub_123");
    });
  });
});
