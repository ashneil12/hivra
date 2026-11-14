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
  // The per-user rate limit keeps counters in module memory, so each test signs
  // in as a fresh user and never counts against another test.
  let userCounter = 0;
  let mockUserId = "user_123";
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
    userCounter += 1;
    mockUserId = `user_managed_card_${userCounter}`;
    jest.useFakeTimers().setSystemTime(new Date("2026-05-13T09:00:00Z"));

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: mockUserId });
    (currentUser as jest.Mock).mockResolvedValue({
      firstName: "Hermes",
      lastName: "User",
      emailAddresses: [{ emailAddress: "hermes@example.com" }],
    });
    (getCreditAccountStripeCustomerId as jest.Mock).mockResolvedValue("cus_existing");
    // The claim returns the customer the account stores: the id passed in, unless a
    // concurrent request claimed the account first.
    (setCreditAccountStripeCustomerId as jest.Mock).mockImplementation(
      async (_userId: string, customerId: string) => customerId
    );

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

  it("credits exactly the whole cents Stripe charges, not a finer requested amount", async () => {
    // 10_000_005 micro-USD is $10.000005: Stripe charges $10.00 (1000 cents), so the
    // wallet must be credited $10.00, never the finer $10.000005.
    const response = await POST(createRequest({ amountMicroUsd: 10_000_005 }));

    expect(response.status).toBe(200);
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          paid_micro_usd: "10000000",
          credit_micro_usd: "10000000",
        }),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 1000 }),
          }),
        ],
      }),
      expect.anything()
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

  it("uses the customer a concurrent top-up stored first instead of its own", async () => {
    // Two first top-ups both read no customer. This request creates cus_new, but the
    // account already holds cus_winner from the other request, so Stripe must use that.
    (getCreditAccountStripeCustomerId as jest.Mock).mockResolvedValueOnce(null);
    (setCreditAccountStripeCustomerId as jest.Mock).mockResolvedValueOnce("cus_winner");

    const response = await POST(createRequest());

    expect(response.status).toBe(200);
    expect(setCreditAccountStripeCustomerId).toHaveBeenCalledWith(mockUserId, "cus_new");
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_winner" }),
      expect.anything()
    );
  });

  it("rate limits one person's card top-up starts before any Stripe work", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await POST(createRequest())).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(5);

    // Another person is not held back by the first one.
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: `${mockUserId}_other` });
    expect((await POST(createRequest())).status).toBe(200);
  });
});
