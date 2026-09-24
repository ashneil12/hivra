/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import CheckoutCanceledPage from "../page";

const mockGet = jest.fn();
const fetchMock = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: mockGet,
  }),
}));

jest.mock("@/components/InteractiveBackground", () => {
  function MockInteractiveBackground() {
    return <div data-testid="interactive-background" />;
  }

  return MockInteractiveBackground;
});

describe("CheckoutCanceledPage", () => {
  const originalLocation = window.location;
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
        href: "http://localhost/checkout/canceled?plan=fleet",
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

  it("shows a dedicated canceled-checkout recovery state without auto-starting checkout", () => {
    render(<CheckoutCanceledPage />);

    expect(screen.getByText(/checkout paused/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was charged/i)).toBeInTheDocument();
    // Plans are chosen in Billing; there is no separate welcome plan picker.
    expect(screen.getByRole("link", { name: /choose a different plan/i })).toHaveAttribute(
      "href",
      "/dashboard/billing"
    );
    expect(screen.queryByRole("link", { name: /skip for now/i })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restarts checkout when the user chooses to try again", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<CheckoutCanceledPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "fleet", cadence: "monthly" }),
      });
    });

    await waitFor(() => {
      expect(assignMock).toHaveBeenCalledWith("https://checkout.stripe.test/session");
    });
  });

  it("sends the user to the dashboard when checkout reports an already-active subscription", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: false,
        error: "You already have an active subscription",
        reason: "ACTIVE_SUBSCRIPTION",
      }),
    } as Response);

    render(<CheckoutCanceledPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(window.location.href).toBe("/dashboard");
    });
  });

  it("shows an inline error when checkout navigation is blocked", async () => {
    assignMock.mockImplementation(() => {
      throw new DOMException("Blocked", "SecurityError");
    });
    fetchMock.mockResolvedValue({
      json: async () => ({
        success: true,
        data: { url: "https://checkout.stripe.test/session" },
      }),
    } as Response);

    render(<CheckoutCanceledPage />);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByText(/couldn't open secure checkout/i)).toBeInTheDocument();
  });

  it("keeps the way back to the launch a checkout started from", async () => {
    mockGet.mockImplementation((key: string) => ({
      plan: "operator",
      returnTo: "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333",
    } as Record<string, string>)[key] ?? null);
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: { url: "https://checkout.stripe.test/session" } }),
    } as Response);

    render(<CheckoutCanceledPage />);

    expect(screen.getByRole("link", { name: /back to your launch/i })).toHaveAttribute(
      "href",
      "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333"
    );
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", expect.objectContaining({
        body: JSON.stringify({
          plan: "operator",
          cadence: "monthly",
          returnTo: "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333",
        }),
      }));
    });
  });

  it("goes back to the launch with the plan it moved to when a retry activates in place", async () => {
    mockGet.mockImplementation((key: string) => ({
      plan: "operator",
      returnTo: "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333",
    } as Record<string, string>)[key] ?? null);
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: { activated: true } }),
    } as Response);

    render(<CheckoutCanceledPage />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(window.location.href).toBe("/dashboard/launch?draft=33333333-3333-4333-8333-333333333333&upgraded=operator");
    });
  });

  it("chooses a different plan in Billing and still comes back to the launch", () => {
    mockGet.mockImplementation((key: string) => ({
      plan: "operator",
      returnTo: "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333",
    } as Record<string, string>)[key] ?? null);
    render(<CheckoutCanceledPage />);
    expect(screen.getByRole("link", { name: /choose a different plan/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?returnTo=%2Fdashboard%2Flaunch%3Fdraft%3D33333333-3333-4333-8333-333333333333",
    );
  });

  it("opens Launch with the plan it moved to when a retry activates in place with nowhere to return", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: { activated: true } }),
    } as Response);

    render(<CheckoutCanceledPage />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => {
      expect(window.location.href).toBe("/dashboard/launch?upgraded=fleet");
    });
  });

  it("ignores a return path that leaves the dashboard", () => {
    mockGet.mockImplementation((key: string) => ({ plan: "operator", returnTo: "//evil.example/dashboard" } as Record<string, string>)[key] ?? null);
    render(<CheckoutCanceledPage />);
    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  });
});
