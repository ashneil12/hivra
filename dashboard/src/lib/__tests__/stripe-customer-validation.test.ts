/**
 * Locks in the abuse-gate behaviour of validateOrRecreateStripeCustomer:
 * a stored Stripe customer must be owned by the same Clerk user (via
 * `metadata.clerk_user_id`). Cross-account reuse must be rejected so an
 * attacker can't re-use someone else's Stripe customer to clear the
 * card-on-file gate.
 */

const stripeMocks = {
  customers: {
    list: jest.fn(),
    retrieve: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
};

jest.mock("stripe", () => {
  const StripeCtor = jest.fn().mockImplementation(() => stripeMocks);
  // Replicate the static error subclasses used by the lib.
  class StripeError extends Error {}
  class StripeInvalidRequestError extends StripeError {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  }
  // @ts-expect-error attaching static for the namespace pattern the lib uses
  StripeCtor.errors = { StripeError, StripeInvalidRequestError };
  return { __esModule: true, default: StripeCtor };
});

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: jest.fn(() => ({
      update: jest.fn().mockReturnThis(),
      eq: jest.fn().mockResolvedValue({ error: null }),
    })),
  },
}));

import { validateOrRecreateStripeCustomer } from "@/lib/stripe";

describe("validateOrRecreateStripeCustomer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    stripeMocks.customers.update.mockResolvedValue({});
  });

  it("accepts a stored customer whose metadata.clerk_user_id matches", async () => {
    stripeMocks.customers.retrieve.mockResolvedValue({
      id: "cus_owned",
      metadata: { clerk_user_id: "user_match" },
    });

    const result = await validateOrRecreateStripeCustomer({
      customerId: "cus_owned",
      clerkUserId: "user_match",
    });

    expect(result).toEqual({ customerId: "cus_owned", wasRecreated: false });
    expect(stripeMocks.customers.create).not.toHaveBeenCalled();
  });

  it("recreates when stored customer's metadata.clerk_user_id belongs to a different user", async () => {
    // Cross-account reuse attempt — must NOT return cus_other.
    stripeMocks.customers.retrieve.mockResolvedValue({
      id: "cus_other",
      metadata: { clerk_user_id: "user_other" },
    });
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_new" });

    const result = await validateOrRecreateStripeCustomer({
      customerId: "cus_other",
      clerkUserId: "user_attacker",
    });

    expect(result).toEqual({ customerId: "cus_new", wasRecreated: true });
    expect(stripeMocks.customers.create).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ clerk_user_id: "user_attacker" }),
      })
    );
  });

  it("backfills metadata on legacy customers without clerk_user_id", async () => {
    stripeMocks.customers.retrieve.mockResolvedValue({
      id: "cus_legacy",
      metadata: {},
    });

    const result = await validateOrRecreateStripeCustomer({
      customerId: "cus_legacy",
      clerkUserId: "user_legacy",
    });

    expect(result).toEqual({ customerId: "cus_legacy", wasRecreated: false });
    expect(stripeMocks.customers.update).toHaveBeenCalledWith(
      "cus_legacy",
      expect.objectContaining({
        metadata: expect.objectContaining({ clerk_user_id: "user_legacy" }),
      })
    );
  });

  it("does NOT link to an email-matched customer owned by another user", async () => {
    // Two Clerk accounts with the same email must not share a Stripe customer.
    stripeMocks.customers.list.mockResolvedValue({
      data: [
        {
          id: "cus_shared_email",
          metadata: { clerk_user_id: "user_first" },
        },
      ],
    });
    stripeMocks.customers.create.mockResolvedValue({ id: "cus_fresh" });

    const result = await validateOrRecreateStripeCustomer({
      customerId: null,
      clerkUserId: "user_second",
      email: "shared@example.com",
    });

    expect(result.customerId).toBe("cus_fresh");
    expect(result.wasRecreated).toBe(true);
  });
});
