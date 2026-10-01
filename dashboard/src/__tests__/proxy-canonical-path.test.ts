import { NextRequest } from "next/server";

jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: jest.fn((handler: unknown) => handler),
  createRouteMatcher: jest.fn(() => () => false),
}));

jest.mock("@/lib/protected-routes", () => ({
  isProtectedPath: jest.fn(() => false),
  PROTECTED_ROUTE_MATCHERS: [],
}));

type ProxyHandler = (auth: { protect: jest.Mock }, request: NextRequest) => Promise<Response>;

const auth = { protect: jest.fn() };

async function run(url: string, init?: ConstructorParameters<typeof NextRequest>[1]): Promise<Response> {
  const { default: handler } = await import("@/proxy");
  return (handler as unknown as ProxyHandler)(auth, new NextRequest(url, init));
}

describe("proxy: percent-encoded paths", () => {
  beforeEach(() => {
    auth.protect.mockClear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // On Vercel, GET /%70ricing answered with the 500 page (the Next launcher
  // looks the encoded text up as a pages router module and throws) and
  // /%54OKENOMICS.md served the file around the rewrite written for
  // /TOKENOMICS.md. The proxy now sends both to the plain path.
  it("redirects an encoded app route to the plain path and keeps the query string", async () => {
    const response = await run("https://hivra.cloud/%70ricing?plan=pro&ref=a%2Fb");

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://hivra.cloud/pricing?plan=pro&ref=a%2Fb");
    expect(auth.protect).not.toHaveBeenCalled();
  });

  it.each([
    ["a static markdown document", "https://hivra.cloud/%54OKENOMICS.md", "https://hivra.cloud/TOKENOMICS.md"],
    ["a static html document", "https://hivra.cloud/docs/litepaper/%69ndex.html", "https://hivra.cloud/docs/litepaper/index.html"],
    ["an encoded period", "https://hivra.cloud/docs/litepaper/index%2ehtml", "https://hivra.cloud/docs/litepaper/index.html"],
    ["a text file", "https://hivra.cloud/%72obots.txt", "https://hivra.cloud/robots.txt"],
    ["an api route", "https://hivra.cloud/api/%68ealth", "https://hivra.cloud/api/health"],
  ])("redirects %s", async (_label, url, expected) => {
    const response = await run(url);

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(expected);
  });

  it("uses 308 so a POST keeps its method and body", async () => {
    const response = await run("https://hivra.cloud/api/%68ealth", { method: "POST", body: "{}" });

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://hivra.cloud/api/health");
  });

  it("lets a plain path through untouched", async () => {
    const response = await run("https://hivra.cloud/pricing?plan=pro");

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    ["an encoded slash", "https://hivra.cloud/a%2Fb"],
    ["an encoded percent sign", "https://hivra.cloud/%2570ricing"],
    ["an encoded space", "https://hivra.cloud/my%20file"],
    ["an encoded multi-byte character", "https://hivra.cloud/caf%C3%A9"],
  ])("does not redirect %s", async (_label, url) => {
    const response = await run(url);

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("never redirects to another host, even when the decoded path starts with two slashes", async () => {
    const response = await run("https://hivra.cloud//%65vil.com/x");

    expect(response.status).toBe(308);
    expect(new URL(response.headers.get("location") as string).host).toBe("hivra.cloud");
  });

  // The URL parser already collapses an encoded dot segment before the proxy
  // sees the request, so the redirect names the path the URL meant and never
  // carries a `..` segment.
  it("never puts a dot segment in the redirect", async () => {
    const response = await run("https://hivra.cloud/a/%2e%2e/%61bout");

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://hivra.cloud/about");
  });

  it("keeps the noindex header on the redirect for a canary host", async () => {
    const response = await run("https://canary.hermesos.cloud/%70ricing", { headers: { host: "canary.hermesos.cloud" } });

    expect(response.status).toBe(308);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  // The cross-origin guard keys on the literal path. A cross-site POST to an
  // encoded api path must still be refused, not redirected into an api route
  // with the browser's cookies.
  it("still refuses a cross-site API mutation sent to an encoded path", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const response = await run("https://hivra.cloud/api/%69nstances/abc", {
      method: "POST",
      headers: { "sec-fetch-site": "cross-site" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
