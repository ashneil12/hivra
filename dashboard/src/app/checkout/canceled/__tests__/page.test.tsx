/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import CheckoutCanceledPage from "../page";

const mockGet = jest.fn();
const fetchMock = jest.fn();
const mockUseAuth = jest.fn();

jest.mock("@clerk/nextjs", () => ({
  useAuth: () => mockUseAuth(),
}));

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
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
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

    expect(screen.getByRole("heading", { level: 1, name: "Your checkout wasn\u2019t completed." })).toBeInTheDocument();
    expect(screen.getByText(/^No subscription has been activated through this checkout attempt\./)).toBeInTheDocument();
    // Plans are chosen in Billing, on its Plans tab; there is no separate
    // welcome plan picker.
    expect(screen.getByRole("link", { name: /choose a different plan/i })).toHaveAttribute(
      "href",
      "/dashboard/billing?tab=plans"
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
      "/dashboard/billing?tab=plans&returnTo=%2Fdashboard%2Flaunch%3Fdraft%3D33333333-3333-4333-8333-333333333333",
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
    expect(screen.queryByRole("link", { name: /^\u2190 back/i })).not.toBeInTheDocument();
  });

  it("carries Ash's words: no activated subscription, a pointer to billing, and the two md links", () => {
    const { container } = render(<CheckoutCanceledPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(container).toHaveTextContent(
      "No subscription has been activated through this checkout attempt. You can return to pricing, review your plan and try again whenever you\u2019re ready.",
    );
    expect(container).toHaveTextContent(
      "If you expected a payment to succeed, check your billing page before trying again to avoid duplicate attempts.",
    );
    expect(screen.getByRole("link", { name: "billing page" })).toHaveAttribute("href", "/dashboard/billing");
    expect(screen.getByRole("link", { name: "Back to pricing" })).toHaveAttribute("href", "/pricing");
    // The md points this at /get-started, which sends a signed-in visitor straight back into checkout.
    expect(screen.getByRole("link", { name: "Open dashboard" })).toHaveAttribute("href", "/dashboard");
  });

  it("no longer claims a charge that this page cannot know about, and names no plan", () => {
    const { container } = render(<CheckoutCanceledPage />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(/nothing was charged|checkout paused|need a different fit/i);
    expect(text).not.toMatch(/\b(?:Pro|Power|Command|Starter)\b/);
  });

  it("names the plan being retried by its price and size", () => {
    render(<CheckoutCanceledPage />);
    expect(screen.getByRole("button", { name: /try again/i })).toHaveTextContent("Try again$19.99/month, 4 vCPU and 8 GB RAM");

    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));
    render(<CheckoutCanceledPage />);
    expect(screen.getAllByRole("button", { name: /try again/i })[1]).toHaveTextContent("Try again$9.99/month, 2 vCPU and 4 GB RAM");
  });

  // A link with no plan, or one the site does not sell, used to retry the larger and dearer size. Nobody chose it.
  it.each([null, "not-a-plan"])("retries the entry size, never the dearer one, when the link names no usable plan (%p)", async (planParam) => {
    mockGet.mockImplementation((key: string) => (key === "plan" ? planParam : null));
    fetchMock.mockResolvedValue({
      json: async () => ({ success: true, data: { url: "https://checkout.stripe.test/session" } }),
    } as Response);

    render(<CheckoutCanceledPage />);
    expect(screen.getByRole("button", { name: /try again/i })).toHaveTextContent("Try again$9.99/month, 2 vCPU and 4 GB RAM");
    expect(screen.getByRole("button", { name: /try again/i })).not.toHaveTextContent(/\$19\.99|4 vCPU/);

    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/billing/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: "operator", cadence: "monthly" }),
      });
    });
  });

  it("sends a visitor who is not signed in and has no plan in the link to the entry size", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation(() => null);
    render(<CheckoutCanceledPage />);

    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/get-started?plan=operator");
  });

  it("shows a failed restart as an alert under the same heading, with the md words still there", async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({ success: false, error: "Card declined", reason: "SOMETHING_ELSE" }),
    } as Response);

    const { container } = render(<CheckoutCanceledPage />);
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Card declined");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your checkout wasn\u2019t completed.");
    expect(container).toHaveTextContent("No subscription has been activated through this checkout attempt.");
  });

  it("gives a visitor who is not signed in the way back to pricing the lead sentence points at", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const { container } = render(<CheckoutCanceledPage />);

    expect(screen.getByRole("heading", { level: 1, name: "Your checkout wasn\u2019t completed." })).toBeInTheDocument();
    expect(container).toHaveTextContent("You can return to pricing, review your plan and try again whenever you\u2019re ready.");
    expect(screen.getByRole("link", { name: "Back to pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("link", { name: /sign up/i })).toHaveAttribute("href", "/get-started?plan=fleet");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sits in one main landmark and keeps decorative glyphs and arrows out of link names", () => {
    mockGet.mockImplementation((key: string) => ({
      plan: "operator",
      returnTo: "/dashboard/launch?draft=33333333-3333-4333-8333-333333333333",
    } as Record<string, string>)[key] ?? null);
    render(<CheckoutCanceledPage />);

    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    expect(screen.getByRole("link", { name: "Back to your launch" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a different plan" })).toBeInTheDocument();
  });

  it("writes no dash, no plan name and no banned claim", () => {
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));
    const { container } = render(<CheckoutCanceledPage />);
    const text = container.textContent ?? "";

    expect(text).not.toMatch(new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`));
    expect(findBannedClaims(text)).toEqual([]);
  });
});
