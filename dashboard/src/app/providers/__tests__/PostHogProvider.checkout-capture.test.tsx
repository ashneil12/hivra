/** @jest-environment jsdom */
//
// Regression coverage for checkout data-quality: the redirect page must
// not emit checkout_payment_completed because the browser cannot prove
// Stripe actually settled the checkout. It may only emit a diagnostic
// redirect-return event; the real conversion event is emitted by
// server-side Stripe confirmation/webhook code.
//
// This file is intentionally separate from PostHogProvider.test.tsx
// because that file uses jest.resetModules() in its beforeEach, which
// invalidates React's hooks dispatcher between an `import("../...")`
// and the subsequent `render()` call. Keeping the capture-behaviour
// suite isolated avoids that.
//
import "@testing-library/jest-dom";
import { render, waitFor } from "@testing-library/react";

const mockCapture = jest.fn();

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    set_config: jest.fn(),
    stopSessionRecording: jest.fn(),
    capture: mockCapture,
    identify: jest.fn(),
    reset: jest.fn(),
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const mockUsePathname = jest.fn(() => "/dashboard/billing");
const mockUseSearchParams = jest.fn(() => new URLSearchParams());

jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
  useSearchParams: () => mockUseSearchParams(),
}));

import { PostHogProvider } from "../PostHogProvider";
import { flushPostHogQueue } from "@/lib/telemetry/posthog-client";

describe("PostHogPageView checkout success capture", () => {
  beforeEach(() => {
    mockCapture.mockClear();
    window.localStorage.clear();
    mockUsePathname.mockReturnValue("/dashboard/billing");
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
    // The pageview/checkout captures go through the init-safe client wrapper,
    // which queues until init flushes the queue. In jsdom init is deferred and
    // never runs, so mark PostHog ready here to mirror a completed init.
    flushPostHogQueue();
  });

  function mockSuccessParams(sessionId = "cs_test_123") {
    const params = new URLSearchParams();
    params.set("subscription", "success");
    params.set("session_id", sessionId);
    mockUseSearchParams.mockReturnValue(params);
  }

  function getPaymentCompletedCaptures() {
    return mockCapture.mock.calls.filter(
      ([event]) => event === "checkout_payment_completed"
    );
  }

  function getRedirectCaptures() {
    return mockCapture.mock.calls.filter(
      ([event]) => event === "checkout_redirect_returned"
    );
  }

  it("captures redirect diagnostics without claiming payment completion when checkout context exists", async () => {
    window.localStorage.setItem(
      "hermes:checkout_plan",
      JSON.stringify({ plan: "operator", cadence: "monthly", started_at: Date.now() - 5000 })
    );
    mockSuccessParams("cs_test_with_localstorage");

    render(<PostHogProvider>{null}</PostHogProvider>);

    await waitFor(() => expect(getRedirectCaptures()).toHaveLength(1));
    expect(getPaymentCompletedCaptures()).toHaveLength(0);
    const props = getRedirectCaptures()[0][1];
    expect(props.plan).toBe("operator");
    expect(props.cadence).toBe("monthly");
    expect(props.payment_status).toBeUndefined();
    expect(props.checkout_context_status).toBe("present");
    expect(props.via_checkout_flow).toBe(true);
    expect(props.session_id).toBe("cs_test_with_localstorage");
    expect(typeof props.time_in_checkout_ms).toBe("number");
    expect(props.time_in_checkout_ms).toBeGreaterThanOrEqual(5000);
  });

  it("clears the localStorage stash after capture so future redirects don't reuse stale data", async () => {
    window.localStorage.setItem(
      "hermes:checkout_plan",
      JSON.stringify({ plan: "fleet", cadence: "yearly", started_at: Date.now() })
    );
    mockSuccessParams();

    render(<PostHogProvider>{null}</PostHogProvider>);

    await waitFor(() => {
      expect(window.localStorage.getItem("hermes:checkout_plan")).toBeNull();
    });
  });

  it("captures missing checkout context without inventing a payment_status", async () => {
    window.localStorage.removeItem("hermes:checkout_plan");
    mockSuccessParams("cs_direct_url_visit");

    render(<PostHogProvider>{null}</PostHogProvider>);

    await waitFor(() => expect(getRedirectCaptures()).toHaveLength(1));
    expect(getPaymentCompletedCaptures()).toHaveLength(0);
    const props = getRedirectCaptures()[0][1];
    expect(props.plan).toBeNull();
    expect(props.cadence).toBeNull();
    expect(props.payment_status).toBeUndefined();
    expect(props.checkout_context_status).toBe("missing");
    expect(props.via_checkout_flow).toBe(false);
    expect(props.time_in_checkout_ms).toBeNull();
  });

  it("does not fire checkout_payment_completed when subscription query param is absent", async () => {
    mockUseSearchParams.mockReturnValue(new URLSearchParams());

    render(<PostHogProvider>{null}</PostHogProvider>);

    await waitFor(() => {
      expect(mockCapture).toHaveBeenCalledWith("$pageview", expect.any(Object));
    });
    expect(getPaymentCompletedCaptures()).toHaveLength(0);
    expect(getRedirectCaptures()).toHaveLength(0);
  });

  it("survives a malformed localStorage payload by logging it as invalid context", async () => {
    window.localStorage.setItem("hermes:checkout_plan", "{not-json");
    mockSuccessParams();

    render(<PostHogProvider>{null}</PostHogProvider>);

    await waitFor(() => expect(getRedirectCaptures()).toHaveLength(1));
    expect(getPaymentCompletedCaptures()).toHaveLength(0);
    const props = getRedirectCaptures()[0][1];
    expect(props.via_checkout_flow).toBe(false);
    expect(props.plan).toBeNull();
    expect(props.checkout_context_status).toBe("invalid");
  });
});
