import { NextRequest } from "next/server";

const mockSessionsCreate = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn().mockResolvedValue({ userId: "user_ws" }),
  currentUser: jest.fn().mockResolvedValue({
    primaryEmailAddress: { emailAddress: "ws@example.com" },
    firstName: "Wes",
    lastName: "Cloud",
  }),
}));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn().mockReturnValue({ success: true }),
  getIP: jest.fn().mockReturnValue("127.0.0.1"),
}));
jest.mock("@/lib/supabase", () => {
  const query = {
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
  };
  return { supabaseAdmin: { from: jest.fn(() => query) } };
});
jest.mock("@/lib/stripe", () => ({
  getStripe: () => ({
    customers: { list: jest.fn().mockResolvedValue({ data: [{ id: "cus_ws" }] }), create: jest.fn() },
    checkout: { sessions: { create: (...args: unknown[]) => mockSessionsCreate(...args) } },
  }),
}));
jest.mock("@/lib/venice/managed-endpoints", () => ({
  getDashboardOrigin: () => "https://dashboard.test",
}));
jest.mock("@/lib/subscription/plans", () => ({
  WORKSPACE_CLOUD_PLANS: {
    ws_cloud_pro: { stripePriceId: "price_ws_pro", stripeYearlyPriceId: "price_ws_pro_y" },
    ws_cloud_power: { stripePriceId: "price_ws_power", stripeYearlyPriceId: "price_ws_power_y" },
  },
  hasDedicatedWorkspaceCloudPrice: () => true,
}));
jest.mock("@/lib/services/workspace-cloud-billing-service", () => ({
  WORKSPACE_CLOUD_SURFACE: "workspace_cloud",
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { POST } from "../route";

describe("POST /api/workspace-cloud/billing/subscribe", () => {
  beforeEach(() => {
    mockSessionsCreate.mockReset();
    mockSessionsCreate.mockResolvedValue({ url: "https://stripe.test/ws" });
  });

  it("sells direct payment only: no promotion codes, trial or discounts", async () => {
    const res = await POST(
      new NextRequest("http://localhost/api/workspace-cloud/billing/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan: "ws_cloud_pro", cadence: "monthly" }),
      })
    );
    expect(res.status).toBe(200);

    const params = mockSessionsCreate.mock.calls[0][0];
    expect(params.allow_promotion_codes).not.toBe(true);
    expect(params).not.toHaveProperty("discounts");
    expect(params.subscription_data).not.toHaveProperty("trial_period_days");
  });
});
