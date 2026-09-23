/** @jest-environment jsdom */
import type { ReactNode } from "react";

const mockAuth = jest.fn();
const mockRedirect = jest.fn();
let requestHeaders: Record<string, string> = {};

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("next/navigation", () => ({ redirect: (url: string) => mockRedirect(url) }));
jest.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => ({ get: (name: string) => requestHeaders[name] ?? null }),
}));
jest.mock("@/components/public-site/PublicSite", () => ({
  __esModule: true,
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import LandingPage from "../page";

/** The page returns <LocaleProvider><PublicSite isSignedIn=…>; read the header's auth input. */
async function renderedHeaderAuth() {
  const page = await LandingPage({});
  return page.props.children.props.isSignedIn;
}

describe("homepage redirect for signed-in visitors", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requestHeaders = { host: "hivra.cloud" };
    mockAuth.mockResolvedValue({ userId: "user_123" });
  });

  it("sends a direct visit (typed URL, bookmark or external link) to the dashboard", async () => {
    requestHeaders["sec-fetch-site"] = "none";
    await LandingPage({});
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("keeps the page for a same-origin navigation such as the header's /#pricing link", async () => {
    requestHeaders["sec-fetch-site"] = "same-origin";
    await LandingPage({});
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("still redirects cross-site arrivals even when they carry a same-host referer header", async () => {
    requestHeaders["sec-fetch-site"] = "cross-site";
    requestHeaders.referer = "https://hivra.cloud/blog";
    await LandingPage({});
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
  });

  it("falls back to a same-host referer when the browser sends no fetch metadata", async () => {
    requestHeaders.referer = "https://hivra.cloud/blog";
    await LandingPage({});
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("keeps the page for an internal link that came back through Clerk's handshake subdomain", async () => {
    requestHeaders["sec-fetch-site"] = "same-site";
    await LandingPage({});
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("marks the header signed in when the server resolves a session", async () => {
    requestHeaders["sec-fetch-site"] = "same-origin";
    expect(await renderedHeaderAuth()).toBe(true);
  });

  it("leaves an unresolved session (e.g. an expired token) to the header's session hint", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    requestHeaders["sec-fetch-site"] = "same-origin";
    expect(await renderedHeaderAuth()).toBeUndefined();
  });

  it("never redirects signed-out visitors", async () => {
    mockAuth.mockResolvedValue({ userId: null });
    requestHeaders["sec-fetch-site"] = "none";
    await LandingPage({});
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
