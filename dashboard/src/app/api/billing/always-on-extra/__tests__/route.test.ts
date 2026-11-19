import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { PLAN_LADDER_ID } from "@/lib/subscription/plan-ladder";
import { testPlanLadder } from "@/test-utils/plan-ladder";
import { makeJsonRequest } from "@/test-utils/request";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: jest.fn() } }));
jest.mock("@/lib/stripe", () => ({ getStripe: jest.fn() }));

describe("POST /api/billing/always-on-extra during a card trial", () => {
  const alwaysOnExtra = { priceId: "price_testAlwaysOn", monthlyCents: 300, maxPerAccount: 5 };

  beforeEach(() => {
    jest.replaceProperty(process, "env", {
      ...process.env,
      HIVRA_PLAN_LADDER: "on",
      HIVRA_PLAN_LADDER_CONFIG: JSON.stringify({ ...testPlanLadder, alwaysOnExtra }),
    });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_1" });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(["trialing", "active"])("uses Stripe status %s to decide whether to sell an extra", async (status) => {
    const update = jest.fn().mockResolvedValue({});
    const write = jest.fn().mockReturnValue({ eq: jest.fn().mockReturnThis() });
    (supabaseAdmin!.from as jest.Mock).mockReturnValue({
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      update: write,
      maybeSingle: jest.fn().mockResolvedValue({
        data: { plan: "operator", plan_ladder: PLAN_LADDER_ID, status: "active", stripe_subscription_id: "sub_123" },
        error: null,
      }),
    });
    (getStripe as jest.Mock).mockReturnValue({
      subscriptions: {
        retrieve: jest.fn().mockResolvedValue({
          id: "sub_123",
          status,
          metadata: { user_id: "user_1", hivra_trial: "card_7d", plan_ladder: PLAN_LADDER_ID },
          items: { data: [{ price: { id: testPlanLadder.plans.operator.monthlyPriceId } }] },
        }),
        update,
      },
    });
    const res = await POST(makeJsonRequest("http://localhost/api/billing/always-on-extra", { quantity: 1 }, {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    }));

    if (status === "trialing") {
      expect(res.status).toBe(409);
      expect(update).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
    } else {
      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledWith(
        "sub_123",
        expect.objectContaining({ items: [{ price: alwaysOnExtra.priceId, quantity: 1 }] }),
        expect.anything(),
      );
    }
  });
});
