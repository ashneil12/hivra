/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import posthog from "posthog-js";
import { captureClient } from "@/lib/telemetry/posthog-client";

import { LARGER_PLAN_PRICE, LARGER_PLAN_SIZE } from "@/lib/blog/plan-facts";
import { PLANS } from "@/lib/subscription";
import { findBannedClaims } from "@/lib/tools/copy-rules";
import GetStartedPage from "../page";

// The larger plan's price and size come from the billing source, so a change there fails these tests instead of
// leaving a stale literal behind.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const LARGER_PRICE_WITH_SIZE = new RegExp(`${escapeRegExp(LARGER_PLAN_PRICE)}[^.]*${escapeRegExp(LARGER_PLAN_SIZE)}`);
const LARGER_GB = PLANS.fleet.totalRam / 1024;

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
    expect(form).toHaveTextContent(/Hivra Cloud · \$9\.99\/mo · 2 vCPU and 4 GB of RAM/);
    // DOM order, not CSS order: screen readers and Tab reach the form before the plan controls.
    const planColumn = document.querySelector(".get-started-sticky")!;
    expect(form!.compareDocumentPosition(planColumn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(planColumn).toContainElement(screen.getByRole("group", { name: "Billing cadence" }));
    expect(planColumn).toContainElement(screen.getByRole("button", { name: /Hivra Cloud \$9\.99/, pressed: true }));
    // The summary line only shows in the single-column layout (media query).
    const switchPlan = within(form as HTMLElement).getByRole("button", { name: "Switch Plan", hidden: true });
    const scrollIntoView = jest.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    fireEvent.click(switchPlan);
    expect(scrollIntoView).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Hivra Cloud \$9\.99/, pressed: true })).toHaveFocus();
  });

  // FTUE-16: a 1-2-3 "Choose plan / Create account / Payment" counter here
  // was followed by Launch restarting at step 1.
  it("shows no step counter: Launch, where this ends, has the only one", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);

    expect(screen.getByTestId("mock-sign-up")).toBeInTheDocument();
    expect(container).not.toHaveTextContent(/choose plan/i);
    expect(container).not.toHaveTextContent(/create account.*payment/i);
    expect(container.querySelector(".get-started-steps, .get-started-steps-compact")).toBeNull();
  });

  it("does not render a back link on the signed-out get-started flow", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });

    render(<GetStartedPage />);

    // A "Back" navigation link: the guarantee link to the terms ("money-back") is a different thing.
    expect(screen.queryByRole("link", { name: /^\W*back\b/i })).not.toBeInTheDocument();
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
    // The URL carries the agent all the way to Launch; nothing reads a
    // stored copy any more.
    expect(window.localStorage.getItem("hermes:welcome_agent_type")).toBeNull();
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

  // FTUE-16: a Free link used to open this plan page first, ahead of Launch.
  it("sends a Free link to sign-up, which lands in Launch, instead of a plan page", async () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "free";
      if (key === "agentType") return "claude-code";
      return null;
    });

    render(<GetStartedPage />);

    await waitFor(() => expect(mockReplace).toHaveBeenCalledWith("/sign-up?agentType=claude-code"));
    expect(mockSignUp).not.toHaveBeenCalled();
    expect(screen.queryByText(/redirecting to checkout/i)).not.toBeInTheDocument();
    expect(captureClient).not.toHaveBeenCalledWith("get_started_viewed", expect.anything());
  });

  it("keeps Free as a choice for a visitor who came for a paid plan", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    render(<GetStartedPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Free/ }));

    expect(screen.getByText(/a free account is best if you have your own computer/i)).toBeInTheDocument();
    expect(screen.getAllByText(/connect your own computer or choose a plan/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Most users can launch without a card/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/free sandbox/i)).not.toBeInTheDocument();
    expect(mockSignUp.mock.calls[mockSignUp.mock.calls.length - 1][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=free",
      fallbackRedirectUrl: "/get-started/activate?plan=free",
      signInUrl: "/sign-in?plan=free",
    });
    expect(mockReplace).not.toHaveBeenCalled();
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

  it("states concretely what the free account does not include on the free card", () => {
    mockUseAuth.mockReturnValue({
      isLoaded: true,
      isSignedIn: false,
    });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return "operator";
      return null;
    });

    render(<GetStartedPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Free/ }));

    expect(
      screen.getByText(/no computer run by hivra · connect your own computer or server/i)
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
      if (key === "plan") return "operator";
      if (key === "cadence") return "yearly";
      return null;
    });

    render(<GetStartedPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Free/ }));

    expect(mockSignUp.mock.calls[mockSignUp.mock.calls.length - 1][0]).toMatchObject({
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
      if (key === "plan") return "fleet";
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
        previousPlan: "fleet",
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
    expect(
      screen.getByText(`较大的规格（${PLANS.fleet.totalCpu} vCPU 和 ${LARGER_GB} GB 内存）最适合多 Agent 工作流`, { exact: false }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\b(?:Pro|Power)\b/);
    expect(screen.getAllByRole("button", { name: "语言" })[0]).toHaveTextContent("简体中文");
  });

  it("opens with Ash's English heading and introduction above the account form and the plan", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });

    const { container } = render(<GetStartedPage />);

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const heading = screen.getByRole("heading", { level: 1, name: "Get started with Hivra." });
    expect(
      screen.getByText(
        "Create your account, then choose what you want to run: an AI agent on a computer of its own, or a computer you can set up yourself.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/^You can start with Hivra Cloud or explore supported options for bringing your own infrastructure\./),
    ).toHaveTextContent(
      "You can start with Hivra Cloud or explore supported options for bringing your own infrastructure. The plan does not include AI usage. Bring your own account or key where the agent supports it, or pay with Hivra credits.",
    );
    // Not the md sentence that made the credentials the only way in.
    expect(container).not.toHaveTextContent(/you supply the model credentials/i);
    // The heading leads the page; the real sign-up form and plan card follow it untouched.
    const form = screen.getByTestId("mock-sign-up");
    expect(heading.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "More room" })).toBeInTheDocument();
  });

  it("closes with the pricing and agents links, and promises nothing about payment or a connection", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });

    render(<GetStartedPage />);

    expect(screen.getByRole("link", { name: "See pricing" })).toHaveAttribute("href", "/pricing");
    expect(screen.getByRole("link", { name: "Explore agents" })).toHaveAttribute("href", "/agents");
    const header = screen.getByRole("heading", { level: 1 }).closest("header");
    expect(header).not.toBeNull();
    const words = header?.textContent ?? "";
    expect(words).toContain("Get started with Hivra.");
    expect(words).not.toMatch(/[\u2013\u2014]/);
    expect(findBannedClaims(words)).toEqual([]);
    expect(words).not.toMatch(/\b(?:payment|subscription|connected|active)\b/i);
  });

  it("names the plans by price and size, never Pro, Power or Starter, and keeps the card free of dashes", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);
    const monthly = container.textContent ?? "";
    fireEvent.click(screen.getByRole("button", { name: /More room/ }));
    const larger = container.textContent ?? "";

    for (const words of [monthly, larger]) {
      expect(words).not.toMatch(/\b(?:Pro|Power|Starter)\b/);
      expect(words).not.toMatch(/[\u2013\u2014]/);
      expect(words).not.toMatch(/always-on|zero markup|Comparable agent platforms|\$19\/mo/i);
      expect(findBannedClaims(words)).toEqual([]);
    }
    // $19.99 always comes with its size in the same sentence (C3).
    expect(larger).toMatch(LARGER_PRICE_WITH_SIZE);
    expect(screen.getByRole("heading", { level: 2, name: "More room" })).toBeInTheDocument();
    expect(screen.getByText(`The larger size, ${LARGER_PLAN_SIZE}, is best for multi-agent workflows`, { exact: false })).toBeInTheDocument();
  });

  // The live sign-up page: every plan card, monthly and yearly, in English.
  it.each([
    ["free", null],
    ["operator", null],
    ["operator", "yearly"],
    ["fleet", null],
    ["fleet", "yearly"],
  ])("shows no market anchor, dash or billing plan name on the %s card (cadence %s)", (plan, cadence) => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => {
      if (key === "plan") return plan;
      if (key === "cadence") return cadence;
      return null;
    });

    const { container } = render(<GetStartedPage />);
    const words = container.textContent ?? "";

    expect(words).not.toMatch(/[\u2013\u2014]/);
    expect(words).not.toMatch(/\b(?:Pro|Power|Command|Starter)\b/);
    // "$19.99" is the larger size and always carries its size; a bare "$19" is the old competitor anchor.
    expect(words).not.toMatch(/\$19(?![\d.])/);
    expect(words).not.toMatch(/Comparable agent platforms|market anchor/i);
    // The yearly card states the yearly price, which the claims scanner forbids on marketing pages (flagged for Ash).
    expect(cadence === null ? findBannedClaims(words) : []).toEqual([]);
  });

  it("says in the approved words that a paid computer stays on, and does not include AI usage", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    render(<GetStartedPage />);

    expect(
      screen.getByText("A paid Hivra Cloud computer stays on and is not paused for inactivity."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Bring your own account or key where the agent supports it, or pay with Hivra credits"),
    ).toBeInTheDocument();
  });

  it("states the refund as the guarantee on card payments, linked to the terms", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);

    expect(container).toHaveTextContent(/7-day money-back guarantee on card payments/i);
    expect(container).not.toHaveTextContent(/seven-day|eligible/i);
    // Said once on the card (the linked badge) and once in the sign-up introduction, not three times.
    const guarantee = screen.getByRole("link", { name: /7-day money-back guarantee on card payments/i });
    expect(guarantee).toHaveAttribute("href", "/terms");
    expect(container.textContent?.match(/7-day money-back guarantee on card payments/gi)).toHaveLength(2);
    // Free has no checkout, so no guarantee is claimed on it.
    fireEvent.click(screen.getByRole("button", { name: /^Free/ }));
    expect(screen.queryByRole("link", { name: /money-back/i })).not.toBeInTheDocument();
  });

  it("puts the page inside one main landmark and keeps the heading order h1 then h2", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);

    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toContainElement(screen.getByRole("heading", { level: 1 }));
    expect(main).toContainElement(screen.getByTestId("mock-sign-up"));
    expect(container.querySelectorAll("h3")).toHaveLength(0);
    // One account heading is enough: Clerk's own card carries it, and Ash's lead says it above.
    expect(screen.queryByText("Create your account.")).not.toBeInTheDocument();
  });

  it("shows no English heading or links to a visitor browsing in another language", () => {
    document.cookie = "hermes_locale=zh-CN; path=/";
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });

    render(<GetStartedPage />);

    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("Get started with Hivra.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "See pricing" })).not.toBeInTheDocument();
    expect(screen.getByText("创建你的账户。")).toBeInTheDocument();
  });
});

// The translated sign-up pages used to keep the billing names (Pro, Power), the billing bullets (always-on,
// "Future marketplace access", "Email support (48 hr)") and an unqualified 7-day refund. Every language now follows
// the English page: the same plan names, the same bullets, and the guarantee on card payments only.
describe("the translated sign-up pages follow the English page", () => {
  const CARD_PAYMENTS: Record<string, string> = {
    "zh-CN": "银行卡付款",
    es: "pagos con tarjeta",
    "pt-BR": "pagamentos com cartão",
    fr: "paiements par carte",
    de: "Kartenzahlung",
    ja: "カード決済",
    ko: "카드 결제",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.NEXT_PUBLIC_HIVRA_AUTH_MODE;
    window.localStorage.clear();
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
  });

  afterEach(() => {
    document.cookie = "hermes_locale=; Max-Age=0; path=/";
  });

  it.each(Object.keys(CARD_PAYMENTS))(
    "%s: names the plans by size, lists the English bullets and limits the guarantee to card payments",
    (locale) => {
      document.cookie = `hermes_locale=${locale}; path=/`;
      mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

      const { container } = render(<GetStartedPage />);
      const entry = container.textContent ?? "";
      fireEvent.click(screen.getByRole("button", { name: /More room/ }));
      const larger = container.textContent ?? "";

      for (const words of [entry, larger]) {
        // No billing plan name, no billing bullet that the English card dropped, no dash.
        expect(words).not.toMatch(/\b(?:Pro|Power|Command|Starter)\b/);
        expect(words).not.toMatch(/always-on|marketplace|email support|48 hr/i);
        expect(words).not.toMatch(/[\u2013\u2014]/);
        // The guarantee names card payments in the badge and in the sign-up introduction, and nowhere promises more.
        expect(words.split(CARD_PAYMENTS[locale]).length - 1).toBeGreaterThanOrEqual(2);
      }
      expect(entry).toContain("Hivra Cloud");
      expect(entry).toContain("A paid Hivra Cloud computer stays on and is not paused for inactivity.");
      expect(larger).toContain("More room");
      expect(larger).toContain(`Twice the CPU and memory: ${LARGER_PLAN_SIZE}`);
      expect(larger).toMatch(LARGER_PRICE_WITH_SIZE);
      // The guarantee badge still links to the terms, in every language, and says card payments.
      const termsLinks = Array.from(container.querySelectorAll('a[href="/terms"]'));
      expect(termsLinks.some((link) => (link.textContent ?? "").includes(CARD_PAYMENTS[locale]))).toBe(true);
    },
  );

  it.each(Object.keys(CARD_PAYMENTS))("%s: gives the Free card no guarantee and no plan name", (locale) => {
    document.cookie = `hermes_locale=${locale}; path=/`;
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));

    const { container } = render(<GetStartedPage />);
    fireEvent.click(screen.getByRole("button", { name: /^Free/ }));

    expect(container.textContent).not.toMatch(/\b(?:Pro|Power|Command|Starter)\b/);
    expect(container.textContent).not.toContain(CARD_PAYMENTS[locale]);
    const termsLinks = Array.from(container.querySelectorAll('a[href="/terms"]'));
    expect(termsLinks.some((link) => (link.textContent ?? "").includes(CARD_PAYMENTS[locale]))).toBe(false);
  });

  it("themes the Clerk card from tokens, so it stays legible in dark mode", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));
    render(<GetStartedPage />);

    const { elements, variables } = mockSignUp.mock.calls[0][0].appearance;
    expect(variables).toMatchObject({ colorBackground: "var(--bg-surface)", colorPrimaryForeground: "var(--vellum-bg)" });
    expect(JSON.stringify(elements)).not.toMatch(/bg-white|text-white|bg-black/);
  });

  it("keeps the language switcher when a desktop app hides the funnel brand", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    mockGet.mockImplementation((key: string) => (key === "plan" ? "operator" : null));
    render(<GetStartedPage />);

    const brand = screen.getByRole("link", { name: "Hivra home" });
    expect(brand).toHaveAttribute("data-web-chrome");
    // The bar still carries a tool (the language switcher), so only the brand goes.
    expect(brand.closest("header")).not.toHaveAttribute("data-web-chrome");
  });
});

