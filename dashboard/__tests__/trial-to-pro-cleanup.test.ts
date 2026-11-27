import { cleanTrialBilling, cleanTrialCustomers } from "../e2e/trial-to-pro/cleanup";
import { cancelSubscription, deleteCustomer, removeOwnedStripeBilling } from "../e2e/trial-to-pro/stripe";

const stripeKey = "sk_test_fixture";
const env = {
  stripeKey,
  baseUrl: "https://dashboard.example.test",
  supabaseUrl: "https://database.example.test",
  serviceRoleKey: "database_fixture",
};
const userId = "user_fixture";
const customerId = "cus_fixture";
const subscriptionId = "sub_fixture";

function mockFetch() {
  return jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected request"));
}

function mutations(fetch: jest.SpyInstance) {
  return fetch.mock.calls.filter(([, init]) => init.method === "DELETE").map(([url]) => url);
}

afterEach(() => jest.restoreAllMocks());

describe("trial-journey Stripe cleanup", () => {
  it("rejects a failed subscription cancellation", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}, { status: 503 }));

    await expect(cancelSubscription(stripeKey, "sub_fixture")).rejects.toThrow(/HTTP 503/);
  });

  it("rejects an unconfirmed customer deletion even with HTTP 200", async () => {
    jest.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "cus_fixture" }));

    await expect(deleteCustomer(stripeKey, "cus_fixture")).rejects.toThrow(/not confirmed/);
  });

  it("accepts a missing artifact, not an unrecognized 404", async () => {
    mockFetch()
      .mockResolvedValueOnce(Response.json({ error: { code: "resource_missing" } }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}, { status: 404 }));

    await expect(deleteCustomer(stripeKey, customerId)).resolves.toBeUndefined();
    await expect(deleteCustomer(stripeKey, customerId)).rejects.toThrow(/HTTP 404/);
  });

  it("does not delete a customer owned by another account", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(Response.json({
      id: customerId, metadata: { clerk_user_id: "user_someoneelse" },
    }));

    await expect(removeOwnedStripeBilling(stripeKey, userId, customerId, subscriptionId))
      .rejects.toThrow(/customer ownership not confirmed/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("does not delete a subscription belonging to another customer", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json({ id: customerId, metadata: { clerk_user_id: userId } }))
      .mockResolvedValueOnce(Response.json({ id: subscriptionId, customer: "cus_someoneelse", status: "active" }));

    await expect(removeOwnedStripeBilling(stripeKey, userId, customerId, subscriptionId))
      .rejects.toThrow(/subscription ownership not confirmed/);
    expect(mutations(fetch)).toEqual([]);
  });
});

describe("trial-journey standing fixture cleanup", () => {
  const startedAt = Date.parse("2026-11-26T13:00:00.000Z");
  const checkoutId = "cs_test_fixture";
  const checkout = {
    id: checkoutId, client_reference_id: userId, customer: customerId, subscription: subscriptionId,
    livemode: false, mode: "subscription", created: startedAt / 1000, metadata: { hivra_trial: "card_7d" },
  };
  const row = { user_id: userId, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId };
  const usage = { id: "usage_fixture", created_at: new Date(startedAt + 1000).toISOString(), stripe_subscription_id: subscriptionId };
  const customer = { id: customerId, metadata: { clerk_user_id: userId } };
  const activeSub = { id: subscriptionId, customer: customerId, status: "active" };

  it("deletes only the Stripe and database artifacts linked to the observed checkout, never Clerk", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json(checkout))
      .mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(Response.json([usage]))
      .mockResolvedValueOnce(Response.json({ data: [activeSub], has_more: false }))
      .mockResolvedValueOnce(Response.json(customer))
      .mockResolvedValueOnce(Response.json(activeSub))
      .mockResolvedValueOnce(Response.json({ id: subscriptionId, status: "canceled" }))
      .mockResolvedValueOnce(Response.json({ id: customerId, deleted: true }))
      .mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([]));

    await expect(cleanTrialBilling(env, userId, [checkoutId], startedAt)).resolves.toBeUndefined();
    expect(mutations(fetch)).toEqual([
      `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
      `https://api.stripe.com/v1/customers/${customerId}`,
      `${env.supabaseUrl}/rest/v1/hermes_subscriptions?user_id=eq.${userId}&stripe_customer_id=eq.${customerId}&stripe_subscription_id=eq.${subscriptionId}`,
      `${env.supabaseUrl}/rest/v1/hermes_trial_usage?user_id=eq.${userId}&id=eq.${usage.id}`,
    ]);
  });

  it("refuses a pre-existing or unrelated checkout before any destructive call", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(Response.json({ ...checkout, created: checkout.created - 1 }));
    await expect(cleanTrialBilling(env, userId, [checkoutId], startedAt)).rejects.toThrow(/owned Stripe test checkout/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("does not treat unreadable database state as empty or delete the customer", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json(checkout))
      .mockResolvedValueOnce(Response.json({}, { status: 503 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ data: [activeSub], has_more: false }));
    await expect(cleanTrialBilling(env, userId, [checkoutId], startedAt)).rejects.toThrow(/HTTP 503/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("refuses to remove a customer's unrelated Stripe subscriptions", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json(checkout))
      .mockResolvedValueOnce(Response.json([row]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ data: [{ ...activeSub, id: "sub_unrelated" }], has_more: false }));
    await expect(cleanTrialBilling(env, userId, [checkoutId], startedAt)).rejects.toThrow(/Unrelated Stripe billing/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("reports ambiguous checkout without widening cleanup and closes both contexts", async () => {
    const fetch = mockFetch();
    const makeFixture = () => ({
      session: { userId, context: { close: jest.fn().mockResolvedValue(undefined) } },
      startedAt, checkoutIds: [], checkoutAttempted: true,
    });
    const first = makeFixture();
    const repeat = makeFixture();
    await expect(cleanTrialCustomers(env, [first, repeat] as never))
      .rejects.toThrow(/first fixture: No verified run checkout.*repeat fixture: No verified run checkout/);
    expect(first.session.context.close).toHaveBeenCalledTimes(1);
    expect(repeat.session.context.close).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
