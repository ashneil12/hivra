/** @jest-environment node */
/**
 * HIVRA_NEW_TOKEN_SURFACES: the one switch that holds back the new token pages
 * and keeps every $HermesOS path (and the UK list) out of the way while off.
 * The real country list is used so the geo checks are not vacuous.
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: jest.fn((handler: unknown) => handler),
  createRouteMatcher: jest.fn(() => () => false),
  auth: jest.fn(async () => ({ userId: null })),
}));
jest.mock("@/lib/protected-routes", () => ({ isProtectedPath: jest.fn(() => false), PROTECTED_ROUTE_MATCHERS: [] }));

import {
  HELD_BACK_PREFIXES,
  heldBackTokenSurfaceTarget,
  newTokenSurfacesEnabled,
} from "@/lib/token-surfaces";
import { resolveTokenGeoBlock, isNewTokenQualificationRefused } from "@/lib/compliance/token-geo-gate";
import { BLOCKED_COUNTRIES } from "@/lib/compliance/token-geo-list";
import { buildLlmsTxt } from "@/lib/llms-txt";
import { getSiteUrls } from "@/lib/seo-urls";
import { serveTokenGeoDocument } from "@/lib/compliance/token-geo-documents";

type ProxyHandler = (auth: unknown, request: NextRequest) => Promise<Response>;

async function runProxy(url: string, signedIn = false): Promise<Response> {
  const { default: handler } = await import("@/proxy");
  const auth = Object.assign(async () => ({ userId: signedIn ? "user_1" : null }), { protect: jest.fn() });
  return (handler as unknown as ProxyHandler)(auth, new NextRequest(url));
}

const original = process.env.HIVRA_NEW_TOKEN_SURFACES;
function setSwitch(value: string | undefined) {
  if (value === undefined) delete process.env.HIVRA_NEW_TOKEN_SURFACES;
  else process.env.HIVRA_NEW_TOKEN_SURFACES = value;
}
afterEach(() => setSwitch(original));

describe("the switch", () => {
  it("is off unless set to a true value", () => {
    expect(newTokenSurfacesEnabled({})).toBe(false);
    expect(newTokenSurfacesEnabled({ HIVRA_NEW_TOKEN_SURFACES: "" })).toBe(false);
    expect(newTokenSurfacesEnabled({ HIVRA_NEW_TOKEN_SURFACES: "false" })).toBe(false);
    for (const on of ["1", "true", "TRUE", " on ", "yes"]) {
      expect(newTokenSurfacesEnabled({ HIVRA_NEW_TOKEN_SURFACES: on })).toBe(true);
    }
  });
});

describe("the proxy while the switch is off", () => {
  beforeEach(() => setSwitch(undefined));

  it.each([
    ["https://hivra.cloud/token", false, "https://hivra.cloud/pricing"],
    ["https://hivra.cloud/token", true, "https://hivra.cloud/dashboard/wallet"],
    ["https://hivra.cloud/token/opengraph-image", false, "https://hivra.cloud/pricing"],
    ["https://hivra.cloud/tokenomics", false, "https://hivra.cloud/pricing"],
    ["https://hivra.cloud/why-hivra/evolution", false, "https://hivra.cloud/why-hivra"],
    ["https://hivra.cloud/dashboard/convert", true, "https://hivra.cloud/dashboard/billing"],
    ["https://hivra.cloud/docs/litepaper", false, "https://hivra.cloud/"],
    ["https://hivra.cloud/LITEPAPER.md", false, "https://hivra.cloud/"],
    ["https://hivra.cloud/WHITEPAPER.md", false, "https://hivra.cloud/"],
    ["https://hivra.cloud/TOKENOMICS.md", false, "https://hivra.cloud/"],
  ])("sends %s (signed in: %s) to %s", async (url, signedIn, expected) => {
    const response = await runProxy(url, signedIn);
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(expected);
  });

  it.each([
    "https://hivra.cloud/pricing",
    "https://hivra.cloud/why-hivra",
    "https://hivra.cloud/tokens-are-not-a-prefix",
    "https://hivra.cloud/dashboard/wallet",
    "https://hivra.cloud/dashboard/billing",
    "https://hivra.cloud/api/billing/wallet/verify",
    "https://hivra.cloud/api/billing/yearly-token-quote",
  ])("leaves %s alone", async (url) => {
    const response = await runProxy(url, true);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("holds back exactly the documented paths", () => {
    expect([...HELD_BACK_PREFIXES].sort()).toEqual(
      ["/LITEPAPER.md", "/TOKENOMICS.md", "/WHITEPAPER.md", "/dashboard/convert", "/docs/litepaper", "/token", "/tokenomics", "/why-hivra/evolution"].sort()
    );
    expect(heldBackTokenSurfaceTarget("/pricing", false)).toBeNull();
  });
});

describe("the proxy while the switch is on", () => {
  it.each(["/token", "/tokenomics", "/why-hivra/evolution", "/dashboard/convert", "/LITEPAPER.md"])("serves %s", async (path) => {
    setSwitch("true");
    const response = await runProxy(`https://canary.hermesos.cloud${path}`, true);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("the UK list while the switch is off", () => {
  const gb = new Request("https://hivra.cloud/api/billing/wallet/quote", { headers: { "x-vercel-ip-country": "GB" } });

  it("uses a real list (not vacuous)", () => {
    expect(BLOCKED_COUNTRIES).toContain("GB");
  });

  it("does not block a UK $HermesOS user, and does not read the stored country", async () => {
    setSwitch(undefined);
    const readStoredCountry = jest.fn(async () => "GB");
    const decision = await resolveTokenGeoBlock(gb, { userId: "user_1" }, { readStoredCountry });
    expect(decision.blocked).toBe(false);
    expect(readStoredCountry).not.toHaveBeenCalled();
    expect(await isNewTokenQualificationRefused("user_1", undefined, { readStoredCountry })).toBe(false);
  });

  it("blocks the same UK request once the switch is on", async () => {
    setSwitch("true");
    const decision = await resolveTokenGeoBlock(gb, null);
    expect(decision.blocked).toBe(true);
  });
});

describe("documents, llms.txt and the sitemap while the switch is off", () => {
  it("redirects the documents to the homepage without reading a file", async () => {
    setSwitch(undefined);
    const response = await serveTokenGeoDocument(new Request("https://hivra.cloud/LITEPAPER.md"), "LITEPAPER.md", {
      dashboardRoot: "/nonexistent",
    });
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/");
  });

  it("drops the papers section and token sentence from llms.txt", () => {
    const off = buildLlmsTxt({ siteUrl: "https://hivra.cloud", tokenSurfaces: false });
    expect(off).not.toMatch(/LITEPAPER|WHITEPAPER|TOKENOMICS|\/token\b|## Papers/);
    expect(off).toContain("## Product");
    const on = buildLlmsTxt({ siteUrl: "https://hivra.cloud" });
    expect(on).toContain("/LITEPAPER.md");
    expect(on).toContain("/token");
  });

  it("drops /token from the sitemap and keeps the rest", () => {
    const off = getSiteUrls({ tokenSurfaces: false }).map((entry) => entry.url);
    const on = getSiteUrls({ tokenSurfaces: true }).map((entry) => entry.url);
    expect(off).not.toContain("https://hivra.cloud/token");
    expect(on).toContain("https://hivra.cloud/token");
    expect(off.length).toBe(on.length - 1);
    expect(off.join(" ")).not.toMatch(/tokenomics|litepaper|evolution|convert/);
  });
});
