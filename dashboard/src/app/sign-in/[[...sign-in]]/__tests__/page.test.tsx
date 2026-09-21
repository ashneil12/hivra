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

});
