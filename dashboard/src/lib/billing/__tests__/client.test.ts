/** @jest-environment jsdom */
import "@testing-library/jest-dom";

import {
  redirectToCheckoutUrl,
  requestCreditTopUpCheckout,
  requestSubscriptionCheckout,
} from "../client";

describe("requestSubscriptionCheckout", () => {
  const fetchMock = jest.fn();
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        origin: "http://localhost",
        assign: jest.fn(),
      },
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("returns the checkout URL when the API succeeds", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session", resumed: true },
      }),
    } as Response);

    await expect(requestSubscriptionCheckout("fleet")).resolves.toEqual({
      ok: true,
      resumed: true,
      url: "https://checkout.stripe.test/session",
    });
  });

  // Regression: the redirect-side checkout_payment_completed event in
  // PostHogProvider only has plan/cadence/payment_status if the
  // checkout flow stashed them in localStorage at session creation.
  // Without this, ~75% of historical events came through with null
  // properties.
  it("stashes plan + cadence + started_at in localStorage when a paid checkout starts", async () => {
    window.localStorage.removeItem("hermes:checkout_plan");
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    const before = Date.now();
    await requestSubscriptionCheckout("operator", "yearly");
    const after = Date.now();

    const raw = window.localStorage.getItem("hermes:checkout_plan");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.plan).toBe("operator");
    expect(parsed.cadence).toBe("yearly");
    expect(parsed.started_at).toBeGreaterThanOrEqual(before);
    expect(parsed.started_at).toBeLessThanOrEqual(after);
  });

  it("forwards the signup-attribution stash in the subscribe body", async () => {
    window.localStorage.setItem(
      "hermes:signup_attribution",
      JSON.stringify({ utm_source: "twitter", landing_page: "/", captured_at: 123 })
    );
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    await requestSubscriptionCheckout("fleet", "monthly");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/billing/subscribe",
      expect.objectContaining({
        body: JSON.stringify({
          plan: "fleet",
          cadence: "monthly",
          attribution: { utm_source: "twitter", landing_page: "/", captured_at: 123 },
        }),
      })
    );
    window.localStorage.removeItem("hermes:signup_attribution");
  });

  it("omits the attribution field when no stash exists or it is corrupt", async () => {
    window.localStorage.setItem("hermes:signup_attribution", "{not-json");
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    await requestSubscriptionCheckout("fleet");

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ plan: "fleet", cadence: "monthly" });
    window.localStorage.removeItem("hermes:signup_attribution");
  });

  it("does not stash localStorage when the checkout API rejects the request", async () => {
    window.localStorage.removeItem("hermes:checkout_plan");
    fetchMock.mockResolvedValue({
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: false,
        error: "Already subscribed",
        reason: "ACTIVE_SUBSCRIPTION",
      }),
    } as Response);

    await requestSubscriptionCheckout("fleet");
    expect(window.localStorage.getItem("hermes:checkout_plan")).toBeNull();
  });

  it("does not stash localStorage when the API grants free access without a checkout URL", async () => {
    window.localStorage.removeItem("hermes:checkout_plan");
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { activated: true },
      }),
    } as Response);

    await requestSubscriptionCheckout("free");
    expect(window.localStorage.getItem("hermes:checkout_plan")).toBeNull();
  });

  it("returns an activated result when the API grants free access", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { activated: true },
      }),
    } as Response);

    await expect(requestSubscriptionCheckout("free")).resolves.toEqual({
      ok: true,
      activated: true,
    });
  });

  it("preserves stable billing reasons from JSON error responses", async () => {
    fetchMock.mockResolvedValue({
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: false,
        error: "You already have an active subscription.",
        reason: "ACTIVE_SUBSCRIPTION",
      }),
    } as Response);

    await expect(requestSubscriptionCheckout("fleet")).resolves.toEqual({
      ok: false,
      message: "You already have an active subscription.",
      reason: "ACTIVE_SUBSCRIPTION",
      status: 400,
    });
  });

  it("falls back cleanly when the API responds with a non-JSON error body", async () => {
    fetchMock.mockResolvedValue({
      status: 502,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => "<html>Bad gateway</html>",
    } as unknown as Response);

    await expect(requestSubscriptionCheckout("fleet")).resolves.toEqual({
      ok: false,
      message: "Failed to start checkout. Please try again.",
      reason: null,
      status: 502,
    });
  });

  it("redirects to checkout when the browser accepts the URL", () => {
    const assignMock = window.location.assign as jest.Mock;

    expect(redirectToCheckoutUrl("https://checkout.stripe.test/session")).toEqual({ ok: true });
    expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
  });

  it("rejects relative checkout targets so callers must provide an absolute URL", () => {
    const assignMock = window.location.assign as jest.Mock;

    expect(redirectToCheckoutUrl("/checkout/session")).toEqual({
      ok: false,
      message: "Couldn't open secure checkout. Please try again.",
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("rejects non-http checkout targets", () => {
    const assignMock = window.location.assign as jest.Mock;

    expect(redirectToCheckoutUrl("javascript:alert('nope')")).toEqual({
      ok: false,
      message: "Couldn't open secure checkout. Please try again.",
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("returns a recoverable error when checkout navigation throws", () => {
    const assignMock = window.location.assign as jest.Mock;
    assignMock.mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });

    expect(redirectToCheckoutUrl("https://checkout.stripe.test/session")).toEqual({
      ok: false,
      message: "Couldn't open secure checkout. Please try again.",
    });
  });

  it("falls back cleanly when the checkout request itself throws", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    await expect(requestSubscriptionCheckout("fleet")).resolves.toEqual({
      ok: false,
      message: "Failed to start checkout. Please try again.",
      reason: null,
      status: 0,
    });
  });
});

describe("requestCreditTopUpCheckout", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as typeof fetch;
  });

  it("returns the top-up checkout URL when the API succeeds", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/topup" },
      }),
    } as Response);

    await expect(requestCreditTopUpCheckout(1000)).resolves.toEqual({
      ok: true,
      resumed: false,
      url: "https://checkout.stripe.test/topup",
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/billing/top-up", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageCredits: 1000 }),
    });
  });

  it("returns a clean error when the top-up API fails", async () => {
    fetchMock.mockResolvedValue({
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        success: false,
        error: "Failed to start credit top-up",
      }),
    } as Response);

    await expect(requestCreditTopUpCheckout(500)).resolves.toEqual({
      ok: false,
      message: "Failed to start credit top-up",
      reason: null,
      status: 500,
    });
  });
});
