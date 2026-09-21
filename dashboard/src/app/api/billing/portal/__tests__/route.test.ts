import Stripe from "stripe";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getStripe, validateOrRecreateStripeCustomer } from "@/lib/stripe";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
  validateOrRecreateStripeCustomer: jest.fn(),
}));

describe("POST /api/billing/portal", () => {
  let consoleErrorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_123" });
    (currentUser as jest.Mock).mockResolvedValue({
      emailAddresses: [{ emailAddress: "test@example.com" }],
      firstName: "Test",
      lastName: "User",
    });
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  function getConsoleOutput() {
    return JSON.stringify(consoleErrorSpy.mock.calls);
  }

  it("does not leak unexpected portal errors to the client or logs", async () => {
    (auth as unknown as jest.Mock).mockRejectedValueOnce(new Error("portal-secret-leak"));

    const response = await POST(new Request("http://localhost/api/billing/portal", { method: "POST" }));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to create portal session");
    expect(json.error).not.toContain("portal-secret-leak");
    expect(getConsoleOutput()).not.toContain("portal-secret-leak");
  });

  it("creates a billing portal session when the customer is valid", async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { stripe_customer_id: "cus_123" },
        error: null,
      }),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(query);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_123",
    });
    const create = jest.fn().mockResolvedValue({
      url: "https://billing.stripe.com/session/test",
    });
    (getStripe as jest.Mock).mockReturnValue({
      billingPortal: {
        sessions: {
          create,
        },
      },
    });

    const response = await POST(new Request("http://localhost/api/billing/portal", { method: "POST" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.url).toBe("https://billing.stripe.com/session/test");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_123",
      })
    );
  });

  it("does not leak raw Stripe portal failures", async () => {
    const query = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: { stripe_customer_id: "cus_123" },
        error: null,
      }),
    };
    (supabaseAdmin!.from as jest.Mock).mockReturnValue(query);
    (validateOrRecreateStripeCustomer as jest.Mock).mockResolvedValue({
      customerId: "cus_123",
    });

    const stripeError = Object.assign(Object.create(Stripe.errors.StripeError.prototype), {
      message: "portal-stripe-secret",
      type: "StripeInvalidRequestError",
      code: "resource_missing",
    });
    const create = jest.fn().mockRejectedValue(stripeError);
    (getStripe as jest.Mock).mockReturnValue({
      billingPortal: {
        sessions: {
          create,
        },
      },
    });

    const response = await POST(new Request("http://localhost/api/billing/portal", { method: "POST" }));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to create portal session");
    expect(JSON.stringify(json)).not.toContain("portal-stripe-secret");
    expect(getConsoleOutput()).not.toContain("portal-stripe-secret");
  });
});
