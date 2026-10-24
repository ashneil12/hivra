/**
 * The token surface view under the COMMITTED country list (GB today), not the empty
 * one jest.setup.tsx gives other suites: if the list stopped reaching the view, these
 * would fail. The pattern is lib/compliance/__tests__/token-geo-pages.test.tsx.
 */
jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const mockHeaders = jest.fn();
jest.mock("next/headers", () => ({ ...jest.requireActual("next/headers"), headers: () => mockHeaders() }));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn(async () => ({ userId: null })) }));
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
    };
  },
}));

import { NEW_TOKEN_SURFACES_ENV } from "@/lib/token-surfaces";

import { isTokenGeoPolicyActive } from "../token-geo-policy";
import { getTokenSurfaceView, tokenSurfacesVisible } from "../token-surface-view";

const saved = process.env[NEW_TOKEN_SURFACES_ENV];

function requestFrom(country?: string) {
  mockHeaders.mockReturnValue(new Headers(country ? { "x-vercel-ip-country": country } : {}));
}

beforeEach(() => {
  process.env[NEW_TOKEN_SURFACES_ENV] = "true";
});

afterEach(() => {
  if (saved === undefined) delete process.env[NEW_TOKEN_SURFACES_ENV];
  else process.env[NEW_TOKEN_SURFACES_ENV] = saved;
});

describe("getTokenSurfaceView with a country listed", () => {
  it("is running against a non-empty policy", () => {
    expect(isTokenGeoPolicyActive()).toBe(true);
  });

  it("marks a viewer in a listed country as blocked, and hides the token copy from them", async () => {
    requestFrom("GB");
    const view = await getTokenSurfaceView();
    expect(view).toEqual({ tokenSurfaces: true, geoBlocked: true });
    expect(tokenSurfacesVisible(view)).toBe(false);
  });

  it("shows the token copy to a viewer anywhere else", async () => {
    requestFrom("US");
    const view = await getTokenSurfaceView();
    expect(view).toEqual({ tokenSurfaces: true, geoBlocked: false });
    expect(tokenSurfacesVisible(view)).toBe(true);
  });

  it("does not block a request with no country (a self-hosted install has no edge)", async () => {
    requestFrom();
    await expect(getTokenSurfaceView()).resolves.toEqual({ tokenSurfaces: true, geoBlocked: false });
  });

  it("lets the switch win: off hides the copy for everyone and the request is never read", async () => {
    process.env[NEW_TOKEN_SURFACES_ENV] = "off";
    requestFrom("US");
    const view = await getTokenSurfaceView();
    expect(view).toEqual({ tokenSurfaces: false, geoBlocked: false });
    expect(tokenSurfacesVisible(view)).toBe(false);
    expect(mockHeaders).not.toHaveBeenCalled();
  });
});
