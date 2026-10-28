/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import ActivatePage from "../page";

// The words on /get-started/activate in each state it can show (10-get-started-activate.md).
const mockGet = jest.fn();
const mockReplace = jest.fn();
const mockUseAuth = jest.fn();
const fetchMock = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => ({ get: mockGet }),
  useRouter: () => ({ replace: mockReplace }),
}));

jest.mock("@clerk/nextjs", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("@/components/InteractiveBackground", () => {
  function MockInteractiveBackground() {
    return <div data-testid="interactive-background" />;
  }
  return MockInteractiveBackground;
});

jest.mock("@/lib/telemetry/posthog-client", () => ({ captureClient: jest.fn() }));

const DASH = new RegExp(`${String.fromCharCode(0x2013)}|${String.fromCharCode(0x2014)}`);
const HEADING = "Finish setting up your Hivra account.";
// A paid plan is about to run a computer. A free account is not: Hivra runs no computer for it (owner decision,
// 21 October 2026), so it is never told it is "nearly ready to run your first computer".
const LEAD = "You’re nearly ready to run your first computer.";
const FREE_LEAD = "Your free account is nearly ready.";
const SMALL_PRINT =
  "If an activation link has expired, request a new one through the sign-in flow. Never share activation codes or links with somebody else.";

function plan(key: string | null) {
  mockGet.mockImplementation((name: string) => (name === "plan" ? key : null));
}

describe("ActivatePage words", () => {
  const originalLocation = window.location;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    plan("operator");
    // Checkout never answers: the page stays in the state under test.
    fetchMock.mockReturnValue(new Promise(() => {}));
    global.fetch = fetchMock as typeof fetch;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: "http://localhost/get-started/activate", origin: "http://localhost", assign: jest.fn() },
    });
  });

  afterAll(() => {
    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });

  it("opens a paid hand-off with the md heading and what is really happening", async () => {
    const { container } = render(<ActivatePage />);

    expect(await screen.findByRole("heading", { level: 1, name: HEADING })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    // Not "complete the steps shown below": the page starts checkout by itself.
    expect(container).toHaveTextContent("Preparing secure checkout. You\u2019ll choose what to launch once your plan is active.");
    expect(container).not.toHaveTextContent(/complete the account steps/i);
    // No plan name in the heading, and no stray plan wording.
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveTextContent(/pro|power|free/i);
    expect(container).toHaveTextContent(SMALL_PRINT);
    expect(screen.queryByRole("link", { name: "Return to sign in" })).not.toBeInTheDocument();
  });

  it("tells a free account what it can do instead of promising it a computer", async () => {
    plan("free");
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { container } = render(<ActivatePage />);

    expect(await screen.findByRole("heading", { level: 1, name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(FREE_LEAD)).toBeInTheDocument();
    expect(screen.queryByText(LEAD)).not.toBeInTheDocument();
    expect(container).toHaveTextContent(
      "Launch opens next, where you can connect your own computer or server. Every Hivra Cloud computer needs a paid plan.",
    );
    expect(container.textContent).not.toMatch(/first computer/i);
  });

  it("offers the way back to sign in only to a visitor who is not signed in", () => {
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    plan("operator");
    const { container } = render(<ActivatePage />);

    expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeInTheDocument();
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    expect(screen.getByText("Please sign in to continue.")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Return to sign in" });
    expect(link).toHaveAttribute("href", "/get-started?plan=operator");
    expect(container).toHaveTextContent(SMALL_PRINT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the confirm-plan choice, under the same heading", () => {
    plan(null);
    const { container } = render(<ActivatePage />);

    expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(/you.re setting up a free account/i);
    expect(screen.getByText(FREE_LEAD)).toBeInTheDocument();
    expect(container).toHaveTextContent(
      "We didn\u2019t see a plan selection, so we\u2019ve defaulted to a free account. A free account works with a computer or server you connect yourself. Confirm to continue, or choose a paid plan instead.",
    );
    expect(container.textContent).not.toMatch(/free plan|first computer/i);
    expect(screen.getByRole("button", { name: "Continue with a free account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /choose a plan/i })).toHaveAttribute("href", "/get-started");
    expect(container).toHaveTextContent(SMALL_PRINT);
    // An unconfirmed free plan is never started by itself.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the retryable error, under the same heading", async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ success: false, error: "Card declined" }) } as Response);
    const { container } = render(<ActivatePage />);

    expect(await screen.findByText("Card declined")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: HEADING })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Something went wrong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(container).toHaveTextContent(SMALL_PRINT);
  });

  it("sits inside one main landmark in every state, with the retry in sentence case", async () => {
    const paid = render(<ActivatePage />);
    await screen.findByRole("heading", { level: 1, name: HEADING });
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    paid.unmount();

    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const out = render(<ActivatePage />);
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    out.unmount();

    plan(null);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const confirm = render(<ActivatePage />);
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
    // Curly apostrophes throughout, like the md lines beside them.
    expect(confirm.container.textContent).toMatch(/You\u2019re setting up a free account/);
    expect(confirm.container.textContent).not.toMatch(/\w'\w/);
    confirm.unmount();

    plan("operator");
    fetchMock.mockResolvedValue({ json: async () => ({ success: false, error: "Card declined" }) } as Response);
    render(<ActivatePage />);
    expect(await screen.findByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByRole("heading", { level: 1 }));
  });

  it("writes no dash and no banned claim in any state", async () => {
    const paid = render(<ActivatePage />);
    await screen.findByRole("heading", { level: 1, name: HEADING });
    const words = [paid.container.textContent ?? ""];
    paid.unmount();

    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: false });
    const out = render(<ActivatePage />);
    words.push(out.container.textContent ?? "");
    out.unmount();

    plan(null);
    mockUseAuth.mockReturnValue({ isLoaded: true, isSignedIn: true });
    const confirm = render(<ActivatePage />);
    words.push(confirm.container.textContent ?? "");

    for (const text of words) {
      expect(text).not.toMatch(DASH);
      expect(text).not.toMatch(/\binstances?\b/i);
      expect(findBannedClaims(text)).toEqual([]);
    }
  });
});
