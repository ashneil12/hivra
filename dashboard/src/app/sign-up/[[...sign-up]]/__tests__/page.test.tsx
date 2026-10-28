/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { redirect } from "next/navigation";

import { findBannedClaims } from "@/lib/tools/copy-rules";
import SignUpPage from "../page";

jest.mock("next/link", () => {
  const MockLink = ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  );
  MockLink.displayName = "MockLink";
  return MockLink;
});

const mockPathname = jest.fn(() => "/sign-up");
jest.mock("next/navigation", () => ({
  redirect: jest.fn(),
  usePathname: () => mockPathname(),
}));

const mockAuth = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));

const mockSignUp = jest.fn();
jest.mock("@clerk/nextjs", () => ({
  SignUp: (props: Record<string, unknown>) => {
    mockSignUp(props);
    return <div data-testid="mock-sign-up">Sign Up</div>;
  },
}));

describe("SignUpPage", () => {
  const originalAuthMode = process.env.HIVRA_AUTH_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    mockPathname.mockReturnValue("/sign-up");
    delete process.env.HIVRA_AUTH_MODE;
    mockAuth.mockResolvedValue({ userId: null });
  });

  afterAll(() => {
    if (originalAuthMode == null) delete process.env.HIVRA_AUTH_MODE;
    else process.env.HIVRA_AUTH_MODE = originalAuthMode;
  });

  it("does not offer hosted account creation for an installation-owned operator", async () => {
    process.env.HIVRA_AUTH_MODE = "local";

    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    expect(ui).toBeNull();
    expect(redirect).toHaveBeenCalledWith("/sign-in");
  });

  it("redirects plan-specific signup traffic into the richer get-started flow", async () => {
    await SignUpPage({
      searchParams: Promise.resolve({ plan: "fleet" }),
    });

    expect(redirect).toHaveBeenCalledWith("/get-started?plan=fleet");
  });

  // FTUE-16: reservation links used to go through the plan picker first.
  it("sends legacy reservation sign-ups straight to Launch like any new account", async () => {
    render(await SignUpPage({
      searchParams: Promise.resolve({ from: "reserve" }),
    }));

    expect(redirect).not.toHaveBeenCalled();
    expect(mockSignUp).toHaveBeenCalledWith(expect.objectContaining({
      fallbackRedirectUrl: "/dashboard/launch?kind=agent&start=1",
    }));
  });

  // FTUE-16: public "start" links now come here, signed in or not.
  it("sends a visitor who is already signed in on to Launch", async () => {
    mockAuth.mockResolvedValue({ userId: "user_1" });
    await SignUpPage({ searchParams: Promise.resolve({ agentType: "codex" }) });

    expect(redirect).toHaveBeenCalledWith("/dashboard/launch?kind=agent&start=1&profile=codex");
  });

  it("keeps the plain signup page available when no plan intent is provided", async () => {
    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    expect(redirect).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  });

  it("shows no step counter before the product, and a Hivra home bar", async () => {
    const ui = await SignUpPage({
      searchParams: Promise.resolve({}),
    });

    render(ui);

    // Launch has the only step counter; a count here contradicted it.
    expect(screen.queryByText(/step \d+ of \d+/i)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/");
  });

  // 11-reserve.md. /reserve and /reserved are redirects to this page, so their words live here.
  it("opens with Ash's heading and introduction above the account form", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));

    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const heading = screen.getByRole("heading", { level: 1, name: "Create your Hivra account." });
    const lead = screen.getByText(
      "Run a supported AI agent on a persistent computer, use a computer without an agent or bring your own infrastructure.",
    );
    const form = screen.getByTestId("mock-sign-up");
    expect(heading.compareDocumentPosition(lead) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(lead.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("main")).toContainElement(heading);
  });

  // Owner decision, 21 October 2026: Hivra runs no free computer. Someone who creates an account is told so
  // before the form, instead of meeting a paywall in Launch after sign-up.
  it("says under the introduction that a Hivra Cloud computer is paid and a free account works with your own", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));

    const rule =
      "Every computer that Hivra Cloud runs for you needs a paid plan, from $9.99 a month for 2 vCPU and 4 GB of RAM. A free account works with a computer or server you connect yourself.";
    const note = screen.getByText(rule);
    expect(note).toBeInTheDocument();
    const lead = screen.getByText(
      "Run a supported AI agent on a persistent computer, use a computer without an agent or bring your own infrastructure.",
    );
    expect(lead.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(screen.getByTestId("mock-sign-up")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("ends on the consent line with working Terms and Privacy links", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));

    const line = screen.getByText(/^By continuing, you agree to the/);
    expect(line).toHaveTextContent(
      "By continuing, you agree to the Terms of Service and acknowledge the Privacy Policy.",
    );
    expect(within(line).getByRole("link", { name: "Terms of Service" })).toHaveAttribute("href", "/terms");
    expect(within(line).getByRole("link", { name: "Privacy Policy" })).toHaveAttribute("href", "/privacy");
    expect(screen.getByTestId("mock-sign-up").compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("uses no dash and makes no banned claim", async () => {
    const { container } = render(await SignUpPage({ searchParams: Promise.resolve({}) }));

    const words = container.textContent ?? "";
    expect(words).not.toMatch(/[\u2013\u2014]/);
    expect(findBannedClaims(words)).toEqual([]);
  });

  it("sends a new account straight to Launch, not the retired welcome flow", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));

    expect(mockSignUp).toHaveBeenCalledWith(expect.objectContaining({
      fallbackRedirectUrl: "/dashboard/launch?kind=agent&start=1",
    }));
  });

  it("opens the agent a link asked for in Launch after sign-up", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({ agentType: "general" }) }));

    expect(mockSignUp).toHaveBeenCalledWith(expect.objectContaining({
      fallbackRedirectUrl: "/dashboard/launch?kind=agent&start=1&profile=hermes",
    }));
  });

  it("themes the Clerk card from tokens, so it stays legible in dark mode", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));
    const { elements, variables } = mockSignUp.mock.calls[0][0].appearance;
    expect(variables).toMatchObject({ colorBackground: "var(--bg-surface)", colorPrimaryForeground: "var(--vellum-bg)" });
    expect(JSON.stringify(elements)).not.toMatch(/bg-white|text-white|bg-black/);
  });

  it("marks the funnel bar as web chrome that a desktop app replaces", async () => {
    render(await SignUpPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "Hivra home" }).closest("header")).toHaveAttribute("data-web-chrome");
  });

  // R8: where sign-ups come from. The answer is optional and goes to Clerk as unsafe metadata.
  describe("How did you hear about Hivra?", () => {
    const lastSignUpProps = () => mockSignUp.mock.calls[mockSignUp.mock.calls.length - 1][0];

    it("asks once, optionally, between the plan note and the account form", async () => {
      render(await SignUpPage({ searchParams: Promise.resolve({}) }));

      const question = screen.getByRole("combobox", { name: /How did you hear about Hivra\?/ });
      expect(question).toHaveValue("");
      expect(question).not.toBeRequired();
      expect(within(question).getByRole("option", { name: "Choose one" })).toBeInTheDocument();
      expect(within(question).getByRole("option", { name: "AI assistant (ChatGPT, Claude, Perplexity)" })).toBeInTheDocument();
      const note = screen.getByText(/^Every computer that Hivra Cloud runs for you needs a paid plan/);
      expect(note.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(question.compareDocumentPosition(screen.getByTestId("mock-sign-up")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // Skipped: Clerk gets no answer.
      expect(lastSignUpProps().unsafeMetadata).toEqual({});
    });

    it("hands the chosen answer to Clerk as unsafe metadata", async () => {
      render(await SignUpPage({ searchParams: Promise.resolve({}) }));

      fireEvent.change(screen.getByRole("combobox", { name: /How did you hear about Hivra\?/ }), { target: { value: "reddit" } });

      expect(lastSignUpProps().unsafeMetadata).toEqual({ heard_about: "reddit" });
      expect(screen.queryByRole("textbox", { name: "Where did you hear about Hivra?" })).not.toBeInTheDocument();
    });

    it("takes a short free-text answer for Somewhere else", async () => {
      render(await SignUpPage({ searchParams: Promise.resolve({}) }));

      fireEvent.change(screen.getByRole("combobox", { name: /How did you hear about Hivra\?/ }), { target: { value: "other" } });
      const where = screen.getByRole("textbox", { name: "Where did you hear about Hivra?" });
      expect(where).toHaveAttribute("maxLength", "100");
      fireEvent.change(where, { target: { value: "  a  Discord server " } });

      expect(lastSignUpProps().unsafeMetadata).toEqual({ heard_about: "other", heard_about_other: "a Discord server" });
    });

    it("carries the first-touch UTM and referrer stash with it", async () => {
      window.localStorage.setItem(
        "hermes:signup_attribution",
        JSON.stringify({ utm_source: "newsletter", referrer: "https://news.ycombinator.com/", landing_page: "/compare", captured_at: 1, junk: "x" }),
      );
      render(await SignUpPage({ searchParams: Promise.resolve({}) }));

      fireEvent.change(screen.getByRole("combobox", { name: /How did you hear about Hivra\?/ }), { target: { value: "hacker_news" } });

      expect(lastSignUpProps().unsafeMetadata).toEqual({
        heard_about: "hacker_news",
        signup_attribution: { utm_source: "newsletter", referrer: "https://news.ycombinator.com/", landing_page: "/compare" },
      });
    });

    it("is gone once the sign-up exists (email code, OAuth callback)", async () => {
      mockPathname.mockReturnValue("/sign-up/verify-email-address");
      render(await SignUpPage({ searchParams: Promise.resolve({}) }));

      expect(screen.queryByRole("combobox", { name: /How did you hear about Hivra\?/ })).not.toBeInTheDocument();
      expect(screen.getByTestId("mock-sign-up")).toBeInTheDocument();
    });
  });
});
