/** @jest-environment node */
/**
 * /dashboard/welcome no longer launches anything. Launch is the one front
 * door; this route only sends older links, emails and bookmarks there.
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

import WelcomePage from "../page";

function visit(searchParams: Record<string, string | string[] | undefined> = {}) {
  return WelcomePage({ searchParams: Promise.resolve(searchParams) });
}

describe("/dashboard/welcome", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockAuth.mockResolvedValue({ userId: "user_a" });
  });

  it("redirects to /sign-in when unauthenticated", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    await expect(visit()).rejects.toThrow(/NEXT_REDIRECT:\/sign-in$/);
  });

  it("sends a signed-in visitor to Launch instead of a launcher of its own", async () => {
    await expect(visit()).rejects.toThrow("NEXT_REDIRECT:/dashboard/launch");
  });

  it("keeps the intent of the old link: the agent it named, and repeated server handoffs", async () => {
    await expect(visit({ step: "deploy", agentType: "general", targetId: [
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ] })).rejects.toThrow(
      "NEXT_REDIRECT:/dashboard/launch?kind=agent&start=1&profile=hermes"
        + "&targetId=22222222-2222-4222-8222-222222222222&targetId=33333333-3333-4333-8333-333333333333",
    );
  });
});
