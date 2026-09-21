import { GET } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { deriveReservedCreditBalance, getCreditSummary } from "@/lib/billing/credits";
import { getLatestHermesTokenHoldingSnapshot } from "@/lib/billing/token-holdings";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/billing/credits", () => ({
  deriveReservedCreditBalance: jest.fn(),
  getCreditSummary: jest.fn(),
}));

jest.mock("@/lib/billing/token-holdings", () => ({
  getLatestHermesTokenHoldingSnapshot: jest.fn(),
}));

describe("GET /api/billing/entitlements", () => {
  const mockUserId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  const originalBillingV2Enabled = process.env.BILLING_V2_ENABLED;
  const originalPublicBillingV2Enabled = process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
  let consoleErrorSpy: jest.SpyInstance;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    setNodeEnv(originalNodeEnv);
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });
    (getCreditSummary as jest.Mock).mockResolvedValue({
      balance: 0,
      monthlyGrant: 0,
      unit: "100 credits = $1",
    });
    (deriveReservedCreditBalance as jest.Mock).mockResolvedValue(0);
    (getLatestHermesTokenHoldingSnapshot as jest.Mock).mockResolvedValue(null);
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    setNodeEnv(originalNodeEnv);
    if (originalBillingV2Enabled === undefined) {
      delete process.env.BILLING_V2_ENABLED;
    } else {
      process.env.BILLING_V2_ENABLED = originalBillingV2Enabled;
    }
    if (originalPublicBillingV2Enabled === undefined) {
      delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_BILLING_V2_ENABLED = originalPublicBillingV2Enabled;
    }
  });

  it("returns 404 in production until billing v2 is enabled", async () => {
    setNodeEnv("production");
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Billing v2 is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(getCreditSummary).not.toHaveBeenCalled();
  });

  it("returns a dry-run compute entitlement decision for the current user", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { plan: "operator", status: "active" },
        error: null,
      }),
    };
    const instancesQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({
        data: [
          {
            id: "inst_123",
            lifecycle_state: "active",
            status: "running",
            cpu_limit: 1,
            ram_limit: 2048,
          },
        ],
        error: null,
      }) }),
    };

    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return subscriptionQuery;
      if (table === "hermes_instances") return instancesQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      mode: "dry_run",
      enforced: false,
      credits: {
        balance: 0,
        unit: "100 credits = $1",
      },
      decision: {
        allowedTier: "operator",
        canProvision: true,
        shouldPause: false,
      },
    });
    expect(getCreditSummary).toHaveBeenCalledWith(mockUserId, "operator");
    expect(deriveReservedCreditBalance).toHaveBeenCalledWith(mockUserId);
    expect(getLatestHermesTokenHoldingSnapshot).toHaveBeenCalledWith(mockUserId);
  });

  it("uses the latest token snapshot for dry-run token-base access", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    };
    const instancesQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({
        data: [],
        error: null,
      }) }),
    };

    (getLatestHermesTokenHoldingSnapshot as jest.Mock).mockResolvedValue({
      id: "snapshot_1",
      balance: 1,
      balanceDisplay: "1",
      qualifiesBaseTier: true,
      checkedAt: "2026-04-24T12:00:00.000Z",
    });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return subscriptionQuery;
      if (table === "hermes_instances") return instancesQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.decision).toMatchObject({
      allowedTier: "token_base",
      canProvision: true,
      shouldPause: false,
    });
    expect(body.data.tokenHolding).toMatchObject({
      id: "snapshot_1",
      qualifiesBaseTier: true,
    });
  });

  it("does not use available credits for dry-run compute access", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    };
    const instancesQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({
        data: [],
        error: null,
      }) }),
    };

    (getCreditSummary as jest.Mock).mockResolvedValue({
      balance: 500,
      monthlyGrant: 0,
      unit: "100 credits = $1",
    });
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return subscriptionQuery;
      if (table === "hermes_instances") return instancesQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.decision).toMatchObject({
      allowedTier: null,
      payAsYouGoEnabled: false,
      canProvision: false,
      failClosed: true,
    });
    expect(body.data.decision.reasons).toContain("Credits are available for billing/top-ups but do not unlock a compute tier.");
  });

  it("subtracts reserved credits before reporting available credit balance", async () => {
    const subscriptionQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: null,
        error: null,
      }),
    };
    const instancesQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      not: jest.fn().mockReturnValue({ not: jest.fn().mockResolvedValue({
        data: [],
        error: null,
      }) }),
    };

    (getCreditSummary as jest.Mock).mockResolvedValue({
      balance: 500,
      monthlyGrant: 0,
      unit: "100 credits = $1",
    });
    (deriveReservedCreditBalance as jest.Mock).mockResolvedValue(350);
    (supabaseAdmin!.from as jest.Mock).mockImplementation((table: string) => {
      if (table === "hermes_subscriptions") return subscriptionQuery;
      if (table === "hermes_instances") return instancesQuery;
      throw new Error(`Unexpected table ${table}`);
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.reservedCredits).toBe(350);
    expect(body.data.decision).toMatchObject({
      allowedTier: null,
      availableCredits: 150,
      canProvision: false,
      failClosed: true,
    });
  });

  it("does not leak backend errors", async () => {
    (supabaseAdmin!.from as jest.Mock).mockImplementation(() => {
      throw new Error("entitlement-secret-leak");
    });

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to evaluate entitlements");
    expect(JSON.stringify(body)).not.toContain("entitlement-secret-leak");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("entitlement-secret-leak");
  });
});
