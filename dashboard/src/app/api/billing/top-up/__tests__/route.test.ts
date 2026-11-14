import { NextRequest } from "next/server";
import { POST } from "../route";
import { auth, currentUser } from "@clerk/nextjs/server";
import {
  creditsToUsd,
  getCreditAccountStripeCustomerId,
  setCreditAccountStripeCustomerId,
} from "@/lib/billing/credits";
import { getStripe } from "@/lib/stripe";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
  currentUser: jest.fn(),
}));

jest.mock("@/lib/billing/credits", () => ({
  creditsToUsd: jest.fn((credits: number) => credits / 100),
  getCreditAccountStripeCustomerId: jest.fn(),
  isTopUpPackageCredits: jest.fn((credits: number) =>
    [500, 1000, 2500, 5000].includes(credits)
  ),
  setCreditAccountStripeCustomerId: jest.fn(),
}));

jest.mock("@/lib/stripe", () => ({
  getStripe: jest.fn(),
}));

describe("POST /api/billing/top-up", () => {
  // The per-user rate limit keeps counters in module memory, so each test signs
  // in as a fresh user and never counts against another test.
  let userCounter = 0;
  let mockUserId = "user_123";
  const originalNodeEnv = process.env.NODE_ENV;
  let mockStripeSessionsCreate: jest.Mock;
  let mockStripeCustomersCreate: jest.Mock;

  function setNodeEnv(value: string | undefined) {
    (process.env as unknown as Record<string, string | undefined>).NODE_ENV = value;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    userCounter += 1;
    mockUserId = `user_top_up_${userCounter}`;
    jest.useFakeTimers().setSystemTime(new Date("2026-04-24T12:00:00Z"));
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.CREDIT_TOPUPS_ENABLED;
    delete process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;

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
      id: "cs_topup",
      url: "https://checkout.stripe.test/topup",
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
    delete process.env.BILLING_V2_ENABLED;
    delete process.env.NEXT_PUBLIC_BILLING_V2_ENABLED;
    delete process.env.CREDIT_TOPUPS_ENABLED;
    delete process.env.NEXT_PUBLIC_CREDIT_TOPUPS_ENABLED;
    jest.useRealTimers();
  });

  function createRequest(body: Record<string, unknown> = { packageCredits: 1000 }) {
    return new NextRequest("http://localhost/api/billing/top-up", {
      method: "POST",
      body: JSON.stringify(body),
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  function createRawRequest(body: string) {
    return new NextRequest("http://localhost/api/billing/top-up", {
      method: "POST",
      body,
      headers: new Headers({ "content-type": "application/json" }),
    });
  }

  it("returns 401 when unauthorized", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });

    const response = await POST(createRequest());

    expect(response.status).toBe(401);
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("stays unavailable in production until billing v2 is enabled", async () => {
    setNodeEnv("production");

    const response = await POST(createRequest({ packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Billing v2 is currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("allows production top-ups when billing v2 is enabled", async () => {
    setNodeEnv("production");
    process.env.BILLING_V2_ENABLED = "true";
    process.env.CREDIT_TOPUPS_ENABLED = "true";

    const response = await POST(createRequest({ packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.url).toBe("https://checkout.stripe.test/topup");
    expect(mockStripeSessionsCreate).toHaveBeenCalled();
  });

  it("keeps production credit checkout closed when only billing v2 is enabled", async () => {
    setNodeEnv("production");
    process.env.BILLING_V2_ENABLED = "true";

    const response = await POST(createRequest({ packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body.error).toBe("Credit top-ups are currently unavailable.");
    expect(auth).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(createRawRequest("{bad"));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid JSON body");
  });

  it("rejects unsupported top-up packages", async () => {
    const response = await POST(createRequest({ packageCredits: 750 }));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toBe("Invalid credit top-up package");
    expect(mockStripeSessionsCreate).not.toHaveBeenCalled();
  });

  it("creates a Stripe payment-mode checkout session with credit package metadata", async () => {
    const response = await POST(createRequest({ packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.url).toBe("https://checkout.stripe.test/topup");
    expect(mockStripeCustomersCreate).not.toHaveBeenCalled();
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer: "cus_existing",
        client_reference_id: mockUserId,
        metadata: {
          type: "credit_topup",
          user_id: mockUserId,
          package_credits: "1000",
          package_usd: "10",
        },
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({
              currency: "usd",
              unit_amount: 1000,
            }),
            quantity: 1,
          }),
        ],
      }),
      expect.objectContaining({
        idempotencyKey: expect.stringContaining(`credit_topup_${mockUserId}_1000_`),
      })
    );
  });

  it("uses a distinct idempotency key per request so same-package top-ups never collide", async () => {
    // Time is frozen by fake timers; a timestamp-bucketed key would collide.
    // The per-request nonce must still make the two keys differ.
    await POST(createRequest({ packageCredits: 1000 }));
    await POST(createRequest({ packageCredits: 1000 }));

    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(2);
    const firstKey = (mockStripeSessionsCreate.mock.calls[0][1] as { idempotencyKey: string })
      .idempotencyKey;
    const secondKey = (mockStripeSessionsCreate.mock.calls[1][1] as { idempotencyKey: string })
      .idempotencyKey;

    expect(firstKey).toMatch(new RegExp(`^credit_topup_${mockUserId}_1000_`));
    expect(secondKey).toMatch(new RegExp(`^credit_topup_${mockUserId}_1000_`));
    expect(firstKey).not.toBe(secondKey);
  });

  it("derives Stripe unit_amount (cents) from the USD price, not the raw credit count", async () => {
    // Regression guard: unit_amount must track creditsToUsd(), so the charge
    // stays correct if the credits-to-USD rate ever diverges from 1:1. Here we
    // simulate a rate where 1000 credits = $20 (2000 cents); a revert to
    // `unit_amount: packageCredits` would charge 1000 cents ($10) instead.
    (creditsToUsd as jest.Mock).mockImplementationOnce((credits: number) => credits / 50);

    const response = await POST(createRequest({ packageCredits: 1000 }));
    expect(response.status).toBe(200);
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ package_usd: "20" }),
        line_items: [
          expect.objectContaining({
            price_data: expect.objectContaining({ unit_amount: 2000 }),
          }),
        ],
      }),
      expect.anything()
    );
  });

  it("creates and stores a Stripe customer when the credit account has none", async () => {
    (getCreditAccountStripeCustomerId as jest.Mock).mockResolvedValueOnce(null);

    const response = await POST(createRequest({ packageCredits: 500 }));

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

    const response = await POST(createRequest({ packageCredits: 500 }));

    expect(response.status).toBe(200);
    expect(setCreditAccountStripeCustomerId).toHaveBeenCalledWith(mockUserId, "cus_new");
    expect(mockStripeSessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_winner" }),
      expect.anything()
    );
  });

  it("rate limits one person's top-up starts before any Stripe work", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await POST(createRequest({ packageCredits: 500 }))).status);
    }

    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(mockStripeSessionsCreate).toHaveBeenCalledTimes(5);

    // Another person is not held back by the first one.
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: `${mockUserId}_other` });
    expect((await POST(createRequest({ packageCredits: 500 }))).status).toBe(200);
  });

  it("does not leak backend errors", async () => {
    mockStripeSessionsCreate.mockRejectedValueOnce(new Error("stripe-topup-secret-leak"));

    const response = await POST(createRequest({ packageCredits: 1000 }));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to start credit top-up");
    expect(JSON.stringify(body)).not.toContain("stripe-topup-secret-leak");
  });
});
