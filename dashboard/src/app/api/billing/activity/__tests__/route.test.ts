import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { GET } from "../route";
import { getBillingActivity } from "@/lib/billing/activity";
import { supabaseAdmin } from "@/lib/supabase";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/activity", () => {
  const actual = jest.requireActual("@/lib/billing/activity");
  return {
    ...actual,
    getBillingActivity: jest.fn(),
  };
});

describe("GET /api/billing/activity", () => {
  const userId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (getBillingActivity as jest.Mock).mockResolvedValue({
      creditLedgerEntries: [],
      paymentTransactions: [],
      computeUsageEvents: [],
      llmUsageEvents: [],
    });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
  });

  function makeRequest(url = "http://localhost/api/billing/activity") {
    return new Request(url) as unknown as NextRequest;
  }

  it("returns 404 in production until billing v2 is enabled", async () => {
    setNodeEnv("production");

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Billing v2 is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(getBillingActivity).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated users", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(getBillingActivity).not.toHaveBeenCalled();
  });

  it("returns recent billing activity for the authenticated user", async () => {
    (getBillingActivity as jest.Mock).mockResolvedValueOnce({
      creditLedgerEntries: [
        {
          id: "ledger_1",
          amountCredits: 1000,
          source: "stripe",
          actor: "stripe_webhook",
          reason: "stripe_topup",
          referenceId: "cs_1",
          createdAt: "2026-04-24T13:00:00.000Z",
        },
      ],
      paymentTransactions: [],
      computeUsageEvents: [],
      llmUsageEvents: [],
    });

    const response = await GET(makeRequest("http://localhost/api/billing/activity?limit=25"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.creditLedgerEntries).toHaveLength(1);
    expect(getBillingActivity).toHaveBeenCalledWith(userId, { limit: 25 }, supabaseAdmin);
  });

  it("does not leak backend errors", async () => {
    (getBillingActivity as jest.Mock).mockRejectedValueOnce(
      new Error("billing-activity-secret")
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch billing activity");
    expect(JSON.stringify(body)).not.toContain("billing-activity-secret");
  });
});
