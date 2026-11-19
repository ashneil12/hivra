import { cleanTrialCustomers } from "../e2e/trial-to-pro/cleanup";
import { cancelSubscription, deleteCustomer, removeOwnedStripeBilling } from "../e2e/trial-to-pro/stripe";

const stripeKey = "sk_test_fixture";
const env = {
  stripeKey,
  baseUrl: "https://dashboard.example.test",
  supabaseUrl: "https://database.example.test",
  clerkSecretKey: "sk_test_clerk_fixture",
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

describe("trial-journey account cleanup", () => {
  const urlFor = (table: string, id = userId) => `${env.supabaseUrl}/rest/v1/${table}?user_id=eq.${id}`;
  const clerkUrl = (id = userId) => `https://api.clerk.com/v1/users/${id}`;
  const subscriptionRow = { user_id: userId, stripe_customer_id: customerId, stripe_subscription_id: subscriptionId };

  it("confirms cleanup using only this account's known artifacts", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json([subscriptionRow]))
      .mockResolvedValueOnce(Response.json({ id: customerId, metadata: { clerk_user_id: userId } }))
      .mockResolvedValueOnce(Response.json({ id: subscriptionId, customer: customerId, status: "active" }))
      .mockResolvedValueOnce(Response.json({ id: subscriptionId, status: "canceled" }))
      .mockResolvedValueOnce(Response.json({ id: customerId, deleted: true }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: userId, deleted: true }));

    await expect(cleanTrialCustomers(env, [{ userId, checkoutAttempted: true }])).resolves.toBeUndefined();
    expect(mutations(fetch)).toEqual([
      `https://api.stripe.com/v1/subscriptions/${subscriptionId}`,
      `https://api.stripe.com/v1/customers/${customerId}`,
      urlFor("hermes_trial_usage"),
      urlFor("hermes_subscriptions"),
      clerkUrl(),
    ]);
  });

  it("keeps the database and identity if Stripe cleanup fails", async () => {
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json([subscriptionRow]))
      .mockResolvedValueOnce(Response.json({ id: customerId, metadata: { clerk_user_id: userId } }))
      .mockResolvedValueOnce(Response.json({ id: subscriptionId, customer: customerId, status: "active" }))
      .mockRejectedValueOnce(new Error("Network failure"));

    await expect(cleanTrialCustomers(env, [{ userId, checkoutAttempted: true }]))
      .rejects.toThrow(/Incomplete cleanup: user_fixture \(Stripe\).*request failed/);
    expect(mutations(fetch)).toEqual([`https://api.stripe.com/v1/subscriptions/${subscriptionId}`]);
  });

  it("reports an ambiguous checkout without widening the deletion scope", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(Response.json([]));

    await expect(cleanTrialCustomers(env, [{ userId, checkoutAttempted: true }]))
      .rejects.toThrow(/Checkout was attempted but the Stripe customer is unknown/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("does not treat a failed subscription read as an absent row", async () => {
    const fetch = mockFetch().mockResolvedValueOnce(Response.json({}, { status: 503 }));

    await expect(cleanTrialCustomers(env, [{ userId }]))
      .rejects.toThrow(/billing lookup.*HTTP 503/);
    expect(mutations(fetch)).toEqual([]);
  });

  it("keeps the authenticated account if its agent inventory cannot be verified", async () => {
    const fetch = mockFetch();
    const context = {
      request: { get: jest.fn().mockRejectedValue(new Error("Transport error")) },
      close: jest.fn().mockResolvedValue(undefined),
    };

    await expect(cleanTrialCustomers(env, [{ userId, signedIn: true, context: context as never }]))
      .rejects.toThrow(/Incomplete cleanup: user_fixture \(agents\): Agent inventory request failed/);
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails on surviving database rows and still cleans the other tracked account", async () => {
    const second = "user_second";
    const fetch = mockFetch()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([{ user_id: userId }]))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: second, deleted: true }));

    await expect(cleanTrialCustomers(env, [{ userId }, { userId: second }]))
      .rejects.toThrow(/Incomplete cleanup: user_fixture \(database\).*hermes_trial_usage still contains rows/);
    expect(mutations(fetch)).toEqual([
      urlFor("hermes_trial_usage"),
      urlFor("hermes_trial_usage", second),
      urlFor("hermes_subscriptions", second),
      clerkUrl(second),
    ]);
  });

  it("reports an unconfirmed Clerk deletion", async () => {
    mockFetch()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ id: userId }));

    await expect(cleanTrialCustomers(env, [{ userId }]))
      .rejects.toThrow(/Clerk user deletion not confirmed/);
  });
});
