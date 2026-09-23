/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import posthog from "posthog-js";
import { captureClient } from "@/lib/telemetry/posthog-client";

import GetStartedPage from "../page";

const mockGet = jest.fn();
const mockReplace = jest.fn();
const mockUseAuth = jest.fn();
const mockSignUp = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({
    get: mockGet,
  }),
  useRouter: () => ({
    replace: mockReplace,
  }),
}));

jest.mock("@clerk/nextjs", () => ({
  useAuth: () => mockUseAuth(),
  SignUp: (props: Record<string, unknown>) => {
    mockSignUp(props);
    return <div data-testid="mock-sign-up">Sign Up</div>;
  },
}));

jest.mock("@/components/InteractiveBackground", () => {
  function MockInteractiveBackground() {
    return <div data-testid="interactive-background" />;
  }

  return MockInteractiveBackground;
});

// The page must route funnel events through the init-safe captureClient wrapper,
// never the raw posthog singleton (which is dropped before the deferred init()).
// Mock the wrapper to assert delegation, and keep the posthog-js mock so a
// regression back to a direct posthog.capture() is caught by the guard below.
jest.mock("@/lib/telemetry/posthog-client", () => ({
  captureClient: jest.fn(),
}));

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    capture: jest.fn(),
  },
}));

describe("GetStartedPage", () => {
  const originalPublicAuthMode = process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    document.cookie = "hermes_locale=; Max-Age=0; path=/";
    window.localStorage.clear();
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: true,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "fleet";
      return null;
    });
  });

  afterAll(() => {
    if (originalPublicAuthMode == null) delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    else process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = originalPublicAuthMode;
  });

  it("routes an independent installation to its local operator instead of account creation", async () => {
    process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE = "local";
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });

    render(<GetStartedPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-in"));
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(screen.getByText("Opening Local Hivra")).toBeInTheDocument();
  });

  it("uses app navigation for signed-in redirects to activation", async () => {
    render(<GetStartedPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/get-started/activate?plan=fleet");
    });
  });

  it("sends a signed-in visitor with Free intent to the dashboard instead of re-activating Free", async () => {
    mockGet.mockImplementation((key: string) => (key === "plan" ? "free" : null));

    render(<GetStartedPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/dashboard"));
    expect(mockReplace).not.toHaveBeenCalledWith(expect.stringContaining("/get-started/activate"));
  });

  it("carries the Hivra home bar and puts the account form ahead of the plan column", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    render(<GetStartedPage />);

    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/");
    const form = screen.getByTestId("mock-sign-up").closest(".get-started-form");
    expect(form).not.toBeNull();
    expect(form).toHaveTextContent(/Pro · \$9\.99\/mo/);
    // DOM order, not CSS order: screen readers and Tab reach the form before the plan controls.
    const planColumn = document.querySelector(".get-started-sticky")!;
    expect(form!.compareDocumentPosition(planColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(planColumn).toContainElement(screen.getByRole("group", { name: "Billing cadence" }));
    expect(planColumn).toContainElement(screen.getByRole("button", { name: /Pro \$9\.99/, pressed: true }));
    // The summary line only shows in the single-column layout (media query).
    const switchPlan = within(form as HTMLElement).getByRole("button", { name: "Switch Plan", hidden: true });
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    fireEvent.click(switchPlan);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Pro \$9\.99/, pressed: true })).toHaveFocus();
  });

  it("keeps the step indicator ahead of the form once the form moves first", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);

    // Wide layout: in the plan column. Single column (media query): above the summary and form.
    expect(container.querySelector(".get-started-sticky .get-started-steps")).toHaveTextContent(/Choose plan.*Create account.*Payment/i);
    const form = container.querySelector(".get-started-form") as HTMLElement;
    const compactSteps = form.querySelector(".get-started-steps-compact")!;
    expect(compactSteps).toHaveTextContent(/Choose plan.*Create account.*Payment/i);
    expect(compactSteps.compareDocumentPosition(form.querySelector(".get-started-summary")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compactSteps.compareDocumentPosition(screen.getByTestId("mock-sign-up")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render a back link on the signed-out get-started flow", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
    expect(screen.getByText(/best for multi-agent workflows/i)).toBeInTheDocument();
  });

  it("preserves first-agent intent across signed-in activation redirects", async () => {
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "operator";
      if (key === "agentType") return "claude-code";
      return null;
    });

    render(<GetStartedPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/get-started/activate?plan=operator&agentType=claude-code");
    });
    expect(window.localStorage.getItem("hermes:welcome_agent_type")).toBe("claude-code");
  });

  it("preserves plan intent across sign-up and sign-in redirects", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    expect(mockSignUp).toHaveBeenCalled();
    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=fleet",
      fallbackRedirectUrl: "/get-started/activate?plan=fleet",
      signInUrl: "/sign-in?plan=fleet",
    });
  });

  it("passes first-agent intent into Clerk sign-up and sign-in URLs", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "operator";
      if (key === "agentType") return "claude-code";
      return null;
    });

    render(<GetStartedPage />);

    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=operator&agentType=claude-code",
      fallbackRedirectUrl: "/get-started/activate?plan=operator&agentType=claude-code",
      signInUrl: "/sign-in?plan=operator&agentType=claude-code",
    });
  });

  it("keeps free plan intent instead of falling back to a paid plan", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      return null;
    });

    render(<GetStartedPage />);

    expect(screen.getByText(/free is best/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Most users can launch without a card/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/higher-risk free-tier deploys may need card verification first/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/free sandbox/i)).not.toBeInTheDocument();
    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=free",
      fallbackRedirectUrl: "/get-started/activate?plan=free",
      signInUrl: "/sign-in?plan=free",
    });
  });

  it("emphasizes Pro with a Most popular badge and defaults to Pro without plan intent", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockReturnValue(null);

    render(<GetStartedPage />);

    expect(screen.getByText(/most popular/i)).toBeInTheDocument();
    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=operator",
      fallbackRedirectUrl: "/get-started/activate?plan=operator",
      signInUrl: "/sign-in?plan=operator",
    });
  });

  it("states concretely what the Free plan lacks on the free card", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      return null;
    });

    render(<GetStartedPage />);

    expect(
      screen.getByText(/no web browsing · no persistent memory · no scheduled tasks · 0\.5 vCPU/i)
    ).toBeInTheDocument();
  });

  it("yearly toggle switches the displayed price and threads cadence into redirect URLs", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "operator";
      return null;
    });

    render(<GetStartedPage />);

    // Monthly by default.
    expect(screen.getByText("$9.99")).toBeInTheDocument();
    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=operator",
    });

    fireEvent.click(screen.getByRole("button", { name: /yearly/i }));

    expect(screen.getByText("$79")).toBeInTheDocument();
    expect(screen.queryByText("$9.99")).not.toBeInTheDocument();
    expect(screen.getAllByText(/save ~34%/i).length).toBeGreaterThan(0);

    const lastSignUpProps = mockSignUp.mock.calls[mockSignUp.mock.calls.length - 1][0];
    expect(lastSignUpProps).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=operator&cadence=yearly",
      fallbackRedirectUrl: "/get-started/activate?plan=operator&cadence=yearly",
      signInUrl: "/sign-in?plan=operator&cadence=yearly",
    });
  });

  it("initializes yearly cadence from the URL and shows the yearly Power price", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "fleet";
      if (key === "cadence") return "yearly";
      return null;
    });

    render(<GetStartedPage />);

    expect(screen.getByText("$149")).toBeInTheDocument();
    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=fleet&cadence=yearly",
      signInUrl: "/sign-in?plan=fleet&cadence=yearly",
    });
  });

  it("never threads a yearly cadence into Free plan redirects", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      if (key === "cadence") return "yearly";
      return null;
    });

    render(<GetStartedPage />);

    expect(mockSignUp.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=free",
      signInUrl: "/sign-in?plan=free",
    });
  });

  it("emits a get_started_viewed funnel event once for signed-out visitors", async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    await waitFor(() => {
      expect(captureClient).toHaveBeenCalledWith(
        "get_started_viewed",
        expect.objectContaining({
          source: "get-started",
          route: "/get-started",
          plan: "fleet",
          cadence: "monthly",
          agentType: null,
        })
      );
    });
    const viewedCalls = (captureClient as jest.Mock).mock.calls.filter(
      ([event]) => event === "get_started_viewed"
    );
    expect(viewedCalls).toHaveLength(1);
  });

  it("does not emit get_started_viewed for already signed-in visitors", async () => {
    // Default mock is signed-in; the page redirects to activation instead.
    render(<GetStartedPage />);

    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/get-started/activate?plan=fleet");
    });
    expect(captureClient).not.toHaveBeenCalledWith(
      "get_started_viewed",
      expect.anything()
    );
  });

  it("emits get_started_plan_selected when the visitor switches plans", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      return null;
    });

    render(<GetStartedPage />);

    // The "Most popular" badge marks the operator/Pro plan switcher button.
    const operatorButton = screen.getByText(/most popular/i).closest("button");
    expect(operatorButton).not.toBeNull();
    fireEvent.click(operatorButton!);

    expect(captureClient).toHaveBeenCalledWith(
      "get_started_plan_selected",
      expect.objectContaining({
        source: "get-started",
        route: "/get-started",
        plan: "operator",
        previousPlan: "free",
        cadence: "monthly",
      })
    );
  });

  it("routes funnel events through the init-safe captureClient, never the raw posthog singleton", async () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    await waitFor(() => {
      expect(captureClient).toHaveBeenCalledWith(
        "get_started_viewed",
        expect.objectContaining({ source: "get-started", route: "/get-started" })
      );
    });
    // The whole point of the fix (discovered resolving aeon ISS-001): PostHog
    // init is deferred, so a capture that touches the raw singleton before init
    // is silently dropped for real users. Nothing here may call it directly.
    expect(posthog.capture).not.toHaveBeenCalled();
  });

  it("renders the setup flow in Chinese when the saved site language is Chinese", () => {
    document.cookie = "hermes_locale=zh-CN; path=/";
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    expect(screen.getByText("创建你的账户。")).toBeInTheDocument();
    expect(screen.getByText("最佳适合")).toBeInTheDocument();
    expect(screen.getByText(/Power 适合多 Agent 工作流/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "语言" })[0]).toHaveTextContent("简体中文");
  });
});
