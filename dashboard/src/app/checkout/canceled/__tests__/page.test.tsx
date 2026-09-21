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
    expect(screen.getByRole("link", { name: /choose a different plan/i })).toHaveAttribute(
      "href",
      "/dashboard/welcome?plan=fleet"
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
});
