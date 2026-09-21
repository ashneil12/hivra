/** @jest-environment node */
/**
 * /dashboard/welcome is a thin server gate. It validates the Clerk
 * session and hands off to <WelcomeFlow />, which owns the
 * loading → plan → deploy → deploying state machine and the
 * entitlement-skip routing. These tests cover the auth gate only —
 * the flow itself is exercised by the client component's own tests.
 */

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
}));

const mockAuth = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({
  auth: () => mockAuth(),
}));

// The client component is a heavy framer-motion + fetch-driven UI.
// The server gate doesn't render it during tests; we just assert the
// gate hands off to the right component.
jest.mock("@/components/dashboard/welcome/WelcomeFlow", () => ({
  WelcomeFlow: function MockWelcomeFlow() {
    return null;
  },
}));

import WelcomePage from "../page";

describe("/dashboard/welcome", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockAuth.mockResolvedValue({ userId: "user_a" });
  });

  it("redirects to /sign-in when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    await expect(WelcomePage()).rejects.toThrow(/NEXT_REDIRECT:\/sign-in/);
  });

  it("renders the welcome flow when authenticated", async () => {
    const tree = await WelcomePage();
    expect(tree).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
