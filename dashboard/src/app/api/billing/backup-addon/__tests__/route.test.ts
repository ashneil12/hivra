import Stripe from "stripe";
import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe } from "@/lib/stripe";
import { enableServerBackup } from "@/lib/hetzner/client";
import { BACKUP_ADDON } from "@/lib/subscription";
import { makeJsonRequest } from "@/test-utils/request";

// Mock external dependencies
jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

jest.mock("@/lib/hetzner/client", () => ({
  enableServerBackup: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue(null),
}));

describe("POST /api/billing/backup-addon", () => {
  const mockUserId = "user_123";
  const mockInstanceId = "123e4567-e89b-12d3-a456-426614174000";
  const mockServerId = 987654;
  const mockSubscriptionId = "sub_xyz123";

  let mockSupabaseQuery: Record<string, jest.Mock>;
  let mockStripeItemsCreate: jest.Mock;
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });

    // Ensure price ID is set for tests
    (BACKUP_ADDON as unknown as { priceId: string }).priceId = "price_backup_test";

    // Setup Supabase chaining mocks
    mockSupabaseQuery = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn(),
      update: jest.fn().mockReturnThis(),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(mockSupabaseQuery);

    // Setup Stripe mock
    mockStripeItemsCreate = jest.fn().mockResolvedValue({});
    (getStripe as jest.Mock).mockReturnValue({
      subscriptionItems: {
        create: mockStripeItemsCreate,
      },
    });

    (enableServerBackup as jest.Mock).mockResolvedValue({});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function createRequest(body: Record<string, unknown> = { instanceId: mockInstanceId }) {
    return makeJsonRequest("http://localhost/api/billing/backup-addon", body, { method: "POST" });
  }

  it("should return 401 if unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    const res = await POST(createRequest());
    expect(res.status).toBe(401);
  });

  it("should return 400 for invalid payload", async () => {
    const res = await POST(createRequest({ instanceId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Invalid instance ID");
  });

  it("should return 404 if instance not found", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({ data: null, error: null });

    const res = await POST(createRequest());
    expect(res.status).toBe(404);
  });

  it("does not leak raw database errors when loading the instance fails", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: null,
      error: { message: 'db leaked "sk-live-secret"' },
    });

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error).toBe("Failed to load instance");
    expect(body.error).not.toContain("sk-live-secret");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("sk-live-secret");
  });

  it("should return 400 if backups are already enabled", async () => {
    mockSupabaseQuery.maybeSingle.mockResolvedValueOnce({
      data: { id: mockInstanceId, backups_enabled: true },
      error: null,
    });

    const res = await POST(createRequest());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Backups are already enabled");
  });

  it("should return 403 if no active subscription", async () => {
    mockSupabaseQuery.maybeSingle
      // First call: instance
      .mockResolvedValueOnce({
        data: { id: mockInstanceId, hetzner_server_id: mockServerId, backups_enabled: false },
        error: null,
      })
      // Second call: subscription
      .mockResolvedValueOnce({
        data: null,
        error: null,
      });

    const res = await POST(createRequest());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Active subscription required");
  });

  it("should successfully enable backups and charge via Stripe", async () => {
    mockSupabaseQuery.maybeSingle
      // First call - instance
      .mockResolvedValueOnce({
        data: { id: mockInstanceId, name: "Test Instance", hetzner_server_id: mockServerId, backups_enabled: false },
        error: null,
      })
      // Second call - subscription
      .mockResolvedValueOnce({
        data: { stripe_subscription_id: mockSubscriptionId, status: "active" },
        error: null,
      });
      
    // No need to mock the update chain's resolution since mockReturnThis() + await handles it gracefully

    const res = await POST(createRequest());
    expect(res.status).toBe(200);

    // Verify Stripe called
    expect(mockStripeItemsCreate).toHaveBeenCalledWith(expect.objectContaining({
      subscription: mockSubscriptionId,
      price: "price_backup_test",
      quantity: 1,
    }));

    // Verify Hetzner API called
    expect(enableServerBackup).toHaveBeenCalledWith(mockServerId);

    // Verify DB update called
    expect(supabaseAdmin!.from).toHaveBeenCalledWith("hermes_instances");
    expect(mockSupabaseQuery.update).toHaveBeenCalledWith({ backups_enabled: true });
    expect(mockSupabaseQuery.eq).toHaveBeenCalledWith("hetzner_server_id", mockServerId);
  });

  it("fails closed without charging or flagging when Hetzner enablement fails", async () => {
    mockSupabaseQuery.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: mockInstanceId,
          name: "Test Instance",
          hetzner_server_id: mockServerId,
          backups_enabled: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { stripe_subscription_id: mockSubscriptionId, status: "active" },
        error: null,
      });

    (enableServerBackup as jest.Mock).mockRejectedValueOnce(new Error("hetzner down"));

    const res = await POST(createRequest());
    const body = await res.json();

    // Failed closed: 502, no Stripe charge, no backups_enabled flag, retry allowed.
    expect(res.status).toBe(502);
    expect(body.error).toContain("not been charged");
    expect(mockStripeItemsCreate).not.toHaveBeenCalled();
    expect(mockSupabaseQuery.update).not.toHaveBeenCalledWith({ backups_enabled: true });
  });

  it("does not leak raw Stripe billing errors when backup addon billing fails", async () => {
    mockSupabaseQuery.maybeSingle
      .mockResolvedValueOnce({
        data: {
          id: mockInstanceId,
          name: "Test Instance",
          hetzner_server_id: mockServerId,
          backups_enabled: false,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { stripe_subscription_id: mockSubscriptionId, status: "active" },
        error: null,
      });

    const stripeError = Object.assign(Object.create(Stripe.errors.StripeError.prototype), {
      message: "stripe-secret-leak",
      type: "StripeInvalidRequestError",
    });
    mockStripeItemsCreate.mockRejectedValueOnce(stripeError);

    const res = await POST(createRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toBe("Unable to update Stripe billing for backups. Please try again.");
    expect(body.error).not.toContain("stripe-secret-leak");
    expect(consoleErrorSpy.mock.calls.flat().join(" ")).not.toContain("stripe-secret-leak");
  });
});
