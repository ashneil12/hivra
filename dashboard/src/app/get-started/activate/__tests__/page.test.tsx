/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import posthog from "posthog-js";
import { captureClient } from "@/lib/telemetry/posthog-client";
import ActivatePage from "../page";

const mockGet = jest.fn();
const mockReplace = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: mockGet,
  }),
  useRouter: () => ({
    replace: mockReplace,
  }),
}));

jest.mock("@/components/InteractiveBackground", () => {
  function MockInteractiveBackground() {
    return <div data-testid="interactive-background" />;
  }

  return MockInteractiveBackground;
});

// The activation page must route funnel events through the init-safe
// captureClient wrapper, never the raw posthog singleton (dropped before the
// deferred init()). Mock the wrapper to assert delegation; keep the posthog-js
// mock so a regression to a direct posthog.capture() is caught by the guard.
jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

describe("ActivatePage", () => {
  const originalLocation = window.location;
  const fetchMock = jest.fn();
  const assignMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "fleet";
      return null;
    });

    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        href: "http://localhost/get-started/activate?plan=fleet",
        origin: "http://localhost",
        assign: assignMock,
      },
    });

    global.fetch = fetchMock as typeof fetch;
  });

  afterAll(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: originalLocation,
    });
  });

  it("starts checkout immediately after render", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "fleet", cadence: "monthly" }),
      });
    });

    expect(captureClient).toHaveBeenCalledWith("activation_started", {
      source: "get-started-activate",
      route: "/get-started/activate",
      plan: "fleet",
      authState: "signed_in",
      checkoutCanceled: false,
    });

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    });

    expect(screen.getByText(/setting up your/i)).toBeInTheDocument();
  });

  it("passes yearly cadence from the URL through to the subscribe request", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "operator";
      if (key === "cadence") return "yearly";
      return null;
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "operator", cadence: "yearly" }),
      });
    });
  });

  it("ignores a stray yearly cadence on free-plan activation", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      if (key === "cadence") return "yearly";
      return null;
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { activated: true },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "free", cadence: "monthly" }),
      });
    });
  });

  it("activates the free plan without opening Stripe checkout", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      return null;
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { activated: true },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "free", cadence: "monthly" }),
      });
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard/welcome?step=agent-type");
    });
    expect(captureClient).toHaveBeenCalledWith("activation_dashboard_reached", {
      source: "get-started-activate",
      route: "/get-started/activate",
      plan: "free",
      destination: "/dashboard/welcome?step=agent-type",
      outcome: "free_plan_activated",
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("preserves explicit first-agent intent when free activation completes", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      if (key === "agentType") return "claude-code";
      return null;
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { activated: true },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard/welcome?step=agent-type&agentType=claude-code");
    });
  });

  it("forwards legacy canceled checkout URLs to the dedicated recovery page", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "fleet";
      if (key === "canceled") return "true";
      return null;
    });

    render(<ActivatePage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/checkout/canceled?plan=fleet");
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses app navigation when the subscription is already active", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: false,
        error: "You already have an active subscription",
        reason: "ACTIVE_SUBSCRIPTION",
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/dashboard");
    });
  });

  it("shows a retryable error when the browser blocks checkout navigation", async () => {
    assignMock.mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    expect(await screen.findByText(/couldn't open secure checkout/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(captureClient).toHaveBeenCalledWith("activation_failed", {
      source: "get-started-activate",
      route: "/get-started/activate",
      plan: "fleet",
      failureType: "checkout_navigation_blocked",
      recoverable: true,
    });
  });

  it("emits activation_page_viewed when a signed-in user reaches the page", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(captureClient).toHaveBeenCalledWith("activation_page_viewed", {
        source: "get-started-activate",
        route: "/get-started/activate",
        plan: "fleet",
        cadence: "monthly",
        authState: "signed_in",
      });
    });
  });

  it("emits activation_checkout_redirected before handing off to Stripe checkout", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    });
    expect(captureClient).toHaveBeenCalledWith("activation_checkout_redirected", {
      source: "get-started-activate",
      route: "/get-started/activate",
      plan: "fleet",
      cadence: "monthly",
    });
  });

  it("routes activation events through captureClient, never the raw posthog singleton", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<ActivatePage />);

    await waitFor(() => {
      expect(captureClient).toHaveBeenCalledWith(
        "activation_started",
        expect.objectContaining({ source: "get-started-activate" })
      );
    });
    // PostHog init is deferred — a capture on the raw singleton before init is
    // silently dropped for real users. Everything must go through captureClient.
    expect(posthog.capture).not.toHaveBeenCalled();
  });
});
