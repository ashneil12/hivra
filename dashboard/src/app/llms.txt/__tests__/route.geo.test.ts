/** @jest-environment node */
/**
 * /llms.txt under the token geo-policy. It was static and cached for an hour for
 * every country, so it carried the token status sentence and the Tokenomics and
 * Token links to viewers the policy blocks. These cases run against the
 * COMMITTED country list (GB), not the empty list jest.setup.tsx gives other
 * suites, so a list that stops reaching the route fails.
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { GET } from "../route";

// The project's own token words (docs/litepaper/restrict.py).
const TOKEN_WORDS = /\$HIVRA|\$HermesOS|tokenomics|\btokens?\b|\bBankr\b/i;

function requestFrom(country?: string) {
  return new NextRequest("https://canary.hermesos.cloud/llms.txt", {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });
}

afterEach(() => jest.restoreAllMocks());

describe("with the committed country list (GB)", () => {
  it("is what the route reads: GB is listed", () => {
    expect(TOKEN_GEO_POLICY.blockedCountries).toContain("GB");
  });

  it("gives a GB viewer the map with no token sentence and no token link", async () => {
    const response = await GET(requestFrom("GB"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toMatch(TOKEN_WORDS);
    expect(body).not.toContain("/TOKENOMICS.md");
    expect(body).not.toMatch(/\]\([^)]*\/token\)/);
    // The rest of the map is there, including the papers that are rewritten to token-free copies for a GB viewer.
    expect(body.startsWith("# Hivra\n")).toBe(true);
    expect(body).toContain("/LITEPAPER.md");
    expect(body).toContain("/WHITEPAPER.md");
    expect(body).toContain("## Legal");
  });

  it("gives another country, and a request with no country, the full map", async () => {
    for (const country of ["FR", undefined]) {
      const body = await (await GET(requestFrom(country))).text();
      expect(body).toContain("$HermesOS is the live token. $HIVRA is a proposed new token and does not exist yet.");
      expect(body).toContain("/TOKENOMICS.md");
      expect(body).toContain("/token)");
    }
  });

  it("is never kept by a shared cache, because the body depends on the country", async () => {
    for (const country of ["GB", "FR", undefined]) {
      const cacheControl = (await GET(requestFrom(country))).headers.get("cache-control") ?? "";
      expect(cacheControl).toBe("private, no-store");
      expect(cacheControl).not.toMatch(/public|s-maxage/);
    }
  });
});

describe("with no country listed", () => {
  beforeEach(() => jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []));

  it("gives a GB request the full map, cached for an hour as before", async () => {
    const response = await GET(requestFrom("GB"));
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600, stale-while-revalidate=86400");
    const body = await response.text();
    expect(body).toContain("$HermesOS is the live token.");
    expect(body).toContain("/TOKENOMICS.md");
  });
});
