import { NextRequest } from "next/server";
import { auth, currentUser } from "@clerk/nextjs/server";

import {
  getCreditAccountStripeCustomerId,
  setCreditAccountStripeCustomerId,
} from "@/lib/billing/credits";
import { getStripe } from "@/lib/stripe";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/billing/credits", () => ({
  getCreditAccountStripeCustomerId: jest.fn(),
  setCreditAccountStripeCustomerId: jest.fn(),
}));

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

describe("POST /api/billing/managed-venice/card/top-up", () => {
  const mockUserId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  const originalManagedVeniceProductId = process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID;
  let mockStripeSessionsCreate: jest.Mock;
  let mockStripeCustomersCreate: jest.Mock;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  function createRequest(body: Record<string, unknown> = { amountMicroUsd: 50_000_000 }) {
    return new NextRequest("http://localhost/api/billing/managed-venice/card/top-up", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers().setSystemTime(new Date("2026-05-13T09:00:00Z"));

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });
    (currentUser as jest.Mock).mockResolvedValue({
      firstName: "Hermes",
      lastName: "User",
      emailAddresses: [{ emailAddress: "hermes@example.com" }],
    });
    (getCreditAccountStripeCustomerId as jest.Mock).mockResolvedValue("cus_existing");
    (setCreditAccountStripeCustomerId as jest.Mock).mockResolvedValue(undefined);

    mockStripeSessionsCreate = jest.fn().mockResolvedValue({
      id: "cs_managed_venice",
      url: "https://checkout.stripe.test/managed-venice",
    });
    mockStripeCustomersCreate = jest.fn().mockResolvedValue({ id: "cus_new" });
    (getStripe as jest.Mock).mockReturnValue({
      checkout: {
        sessions: {
          create: mockStripeSessionsCreate,
        },
      },
      customers: {
        create: mockStripeCustomersCreate,
      },
    });
  });

  afterEach(() => {
    setNodeEnv(originalNodeEnv);
    if (originalManagedVeniceProductId === undefined) {
      delete process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID;
    } else {
      process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID = originalManagedVeniceProductId;
    }
    jest.useRealTimers();
  });

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects tiny or malformed top-up amounts", async () => {
    const response = await POST(createRequest({ amountMicroUsd: 1_000_000 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid managed Venice card top-up amount");
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("creates a Stripe checkout that credits the managed Venice card wallet", async () => {
    setNodeEnv("production");
    process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID = "prod_managed_venice_live";

    const response = await POST(createRequest({ amountMicroUsd: 50_000_000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.url).toBe("https://checkout.stripe.test/managed-venice");
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: "cus_existing",
        client_reference_id: mockUserId,
        metadata: {
          type: "managed_venice_card_topup",
          user_id: mockUserId,
          wallet_type: "card",
          paid_micro_usd: "50000000",
          credit_micro_usd: "50000000",
        },
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "usd",
              product: "prod_managed_venice_live",
              unit_amount: 5000,
            }),
            quantity: 1,
          }),
        ],
        success_url: expect.stringContaining("managedVenice=card_success"),
        cancel_url: expect.stringContaining("managedVenice=card_canceled"),
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(`managed_venice_card_topup_${mockUserId}_50000000_`),
      })
    );
  });

  it("uses a distinct idempotency key per request so same-amount top-ups never collide", async () => {
    // Time is frozen by fake timers, so a timestamp-bucketed key would collide.
    // The per-request nonce must still make the two keys differ.
    await POST(createRequest({ amountMicroUsd: 50_000_000 }));
    await POST(createRequest({ amountMicroUsd: 50_000_000 }));

    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(2);
    const firstKey = (mockStripeSessionsCreate.mock.calls[0][1] as { idempotencyKey: string })
      .idempotencyKey;
    const secondKey = (mockStripeSessionsCreate.mock.calls[1][1] as { idempotencyKey: string })
      .idempotencyKey;

    expect(firstKey).toMatch(new RegExp(`^managed_venice_card_topup_${mockUserId}_50000000_`));
    expect(secondKey).toMatch(new RegExp(`^managed_venice_card_topup_${mockUserId}_50000000_`));
    expect(firstKey).not.toBe(secondKey);
  });

  it("falls back to inline product data when no managed Venice product is configured", async () => {
    delete process.env.STRIPE_MANAGED_VENICE_CREDITS_PRODUCT_ID;

    const response = await POST(createRequest({ amountMicroUsd: 50_000_000 }));

    expect(response.status).toBe(200);
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              product_data: {
                name: "$50.00 managed Venice card credits",
              },
            }),
          }),
        ],
      }),
      expect.anything()
    );
  });

  it("creates and stores a Stripe customer when the credit account has none", async () => {
    (getCreditAccountStripeCustomerId as jest.Mock).mockResolvedValueOnce(null);

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(mockStripeCustomersCreate).toHaveBeenCalledWith({
      email: "hermes@example.com",
      name: "Hermes User",
      metadata: { clerk_user_id: mockUserId },
    });
    expect(setCreditAccountStripeCustomerId).toHaveBeenCalledWith(mockUserId, "cus_new");
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_new" }),
      expect.anything()
    );
  });
});
