/** @jest-environment node */
/**
 * The committed country list, run through the code that reads it.
 *
 * jest.setup.tsx gives every suite an EMPTY list, so a suite that mocks nothing
 * can't tell a live gate from a dead one: changing token-geo-policy.ts to
 * `blockedCountries: []`, or the rewrites to read another list, passed every
 * geo test. This file opts back in to the real list and never replaces the
 * policy, so it fails when the list stops reaching the policy, the gate or the
 * token-geo route. The four token documents are covered the same way by
 * src/__tests__/token-geo-document-routes.test.ts. The other geo suites do the same for their
 * blocked-country cases (billing token-geo-routes, token-geo-pages, the
 * token-geo route), so the list is proven to reach every token route and page.
 */
import { NextRequest } from "next/server";

jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: null })) }));

import { GET as tokenGeoRoute } from "@/app/api/token-geo/route";
import { BLOCKED_COUNTRIES } from "../token-geo-list";
import { resolveTokenGeoBlock } from "../token-geo-gate";
import { TOKEN_GEO_POLICY, isTokenGeoPolicyActive } from "../token-geo-policy";

const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";

function requestFrom(country?: string) {
  return new NextRequest("https://canary.hermesos.cloud/api/token-geo", {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });
}

describe("the committed country list is live", () => {
  it("is not the empty list jest.setup.tsx gives other suites", () => {
    expect(BLOCKED_COUNTRIES).toContain("GB");
    expect(isTokenGeoPolicyActive()).toBe(true);
  });

  it("reaches the policy: TOKEN_GEO_POLICY lists exactly the committed countries", () => {
    expect([...TOKEN_GEO_POLICY.blockedCountries]).toEqual([...BLOCKED_COUNTRIES]);
  });

  it("reaches the gate, with no policy passed: a GB request is blocked and a French one is not", async () => {
    await expect(resolveTokenGeoBlock(requestFrom("GB"), null)).resolves.toEqual({
      blocked: true,
      country: "GB",
      signal: "ip_country",
      message: GB_NOTICE,
    });
    await expect(resolveTokenGeoBlock(requestFrom("FR"), null)).resolves.toEqual({ blocked: false });
    // An unknown IP country is not a country, so it is not blocked.
    await expect(resolveTokenGeoBlock(requestFrom(), null)).resolves.toEqual({ blocked: false });
  });
});

describe("GET /api/token-geo with the committed list", () => {
  it("tells a GB visitor token features are off, and anyone else they are on", async () => {
    const blocked = await tokenGeoRoute(requestFrom("GB"));
    await expect(blocked.json()).resolves.toMatchObject({ blocked: true, notice: GB_NOTICE });
    const allowed = await tokenGeoRoute(requestFrom("FR"));
    await expect(allowed.json()).resolves.toEqual({ blocked: false, notice: null });
  });
});
