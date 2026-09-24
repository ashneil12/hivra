/** @jest-environment jsdom */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

import SignInPage from "../page";

const mockSignIn = jest.fn();

jest.mock("@clerk/nextjs", () => ({
  SignIn: (props: Record<string, unknown>) => {
    mockSignIn(props);
    return <div data-testid="mock-sign-in">Sign In</div>;
  },
}));

describe("SignInPage", () => {
  const originalAuthMode = process.env.HIVRA_AUTH_MODE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HIVRA_AUTH_MODE;
  });

  afterAll(() => {
    if (originalAuthMode === undefined) delete process.env.HIVRA_AUTH_MODE;
    else process.env.HIVRA_AUTH_MODE = originalAuthMode;
  });

  it("does not render a back button that navigates away from auth", async () => {
    const page = await SignInPage({
      searchParams: Promise.resolve({}),
    });

    render(page);

    expect(screen.queryByText(/back to entry/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /back/i })).not.toBeInTheDocument();
  });

  it("returns plan-intent sign-ins to activation instead of the generic welcome page", async () => {
    const page = await SignInPage({
      searchParams: Promise.resolve({ plan: "fleet" }),
    });

    render(page);

    expect(mockSignIn).toHaveBeenCalled();
    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=fleet",
      fallbackRedirectUrl: "/get-started/activate?plan=fleet",
      signUpUrl: "/get-started?plan=fleet",
    });
  });

  it("preserves first-agent intent through plan sign-in redirects", async () => {
    const page = await SignInPage({
      searchParams: Promise.resolve({ plan: "operator", agentType: "claude-code" }),
    });

    render(page);

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/get-started/activate?plan=operator&agentType=claude-code",
      fallbackRedirectUrl: "/get-started/activate?plan=operator&agentType=claude-code",
      signUpUrl: "/get-started?plan=operator&agentType=claude-code",
    });
  });

  it("returns a hosted sign-in to Home, never the retired welcome flow", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({}) }));

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      fallbackRedirectUrl: "/dashboard",
      signUpUrl: "/sign-up",
    });
    expect(mockSignIn.mock.calls[0][0]).not.toHaveProperty("forceRedirectUrl");
  });

  it("opens the agent a link asked for in Launch, through sign-in or sign-up", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({ agentType: "codex" }) }));

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/dashboard/launch?kind=agent&start=1&profile=codex",
      fallbackRedirectUrl: "/dashboard/launch?kind=agent&start=1&profile=codex",
      signUpUrl: "/sign-up?agentType=codex",
    });
  });

  it("links the funnel brand home on hosted sign-in", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/");
  });

  it("does not offer a home link that loops back to sign-in under local auth", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    render(await SignInPage({ searchParams: Promise.resolve({}) }));
    expect(screen.queryByRole("link", { name: "Hivra home" })).not.toBeInTheDocument();
    expect(screen.getByText("Hivra")).toBeInTheDocument();
  });

  it("returns self-hosted operators to the control plane instead of legacy onboarding", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    const page = await SignInPage({ searchParams: Promise.resolve({}) });

    render(page);

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      fallbackRedirectUrl: "/dashboard",
    });
    expect(mockSignIn.mock.calls[0][0]).not.toHaveProperty("forceRedirectUrl");
  });

  it("preserves a safe deep link through sign in", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    const page = await SignInPage({
      searchParams: Promise.resolve({ redirect_url: "/dashboard/computers?launch=1" }),
    });

    render(page);

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      forceRedirectUrl: "/dashboard/computers?launch=1",
      fallbackRedirectUrl: "/dashboard/computers?launch=1",
    });
  });

  it("rejects external redirect targets", async () => {
    process.env.HIVRA_AUTH_MODE = "local";
    const page = await SignInPage({
      searchParams: Promise.resolve({ redirect_url: "//attacker.example" }),
    });

    render(page);

    expect(mockSignIn.mock.calls[0][0]).toMatchObject({
      fallbackRedirectUrl: "/dashboard",
    });
    expect(mockSignIn.mock.calls[0][0]).not.toHaveProperty("forceRedirectUrl");
  });

  it("keeps a Hivra home bar above the form and lets Clerk use the full column", async () => {
    const page = await SignInPage({ searchParams: Promise.resolve({}) });

    render(page);

    expect(screen.getByRole("link", { name: "Hivra home" })).toHaveAttribute("href", "/");
    expect(mockSignIn.mock.calls[0][0].appearance.elements).toMatchObject({
      rootBox: "w-full",
      cardBox: "w-full max-w-full",
    });
  });

  it("themes the Clerk card from tokens, so it stays legible in dark mode", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({}) }));
    const { elements, variables } = mockSignIn.mock.calls[0][0].appearance;
    expect(variables).toMatchObject({
      colorBackground: "var(--bg-surface)",
      colorForeground: "var(--ink-black)",
      colorPrimaryForeground: "var(--vellum-bg)",
    });
    expect(variables).not.toHaveProperty("colorText");
    expect(JSON.stringify(elements)).not.toMatch(/bg-white|text-white|bg-black/);
    expect(elements.formButtonPrimary).toMatch(/text-\[var\(--vellum-bg\)\].*text-center flex justify-center/);
  });

  it("marks the funnel bar as web chrome that a desktop app replaces", async () => {
    render(await SignInPage({ searchParams: Promise.resolve({}) }));
    const bar = screen.getByRole("link", { name: "Hivra home" }).closest("header");
    expect(bar).toHaveAttribute("data-web-chrome");
  });

});
