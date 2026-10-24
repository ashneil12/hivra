/**
 * The token surface view with the dormant geo policy (jest.setup.tsx empties the
 * country list for every suite): nothing may read the request. The listed-country
 * cases are in token-surface-view.geo.test.ts.
 */
const mockHeaders = jest.fn(() => {
  throw new Error("the request must not be read");
});
jest.mock("next/headers", () => ({ ...jest.requireActual("next/headers"), headers: () => mockHeaders() }));

import { NEW_TOKEN_SURFACES_ENV } from "@/lib/token-surfaces";

import { getTokenSurfaceView, tokenSurfacesVisible, type TokenSurfaceView } from "../token-surface-view";

const saved = process.env[NEW_TOKEN_SURFACES_ENV];

afterEach(() => {
  if (saved === undefined) delete process.env[NEW_TOKEN_SURFACES_ENV];
  else process.env[NEW_TOKEN_SURFACES_ENV] = saved;
});

describe("getTokenSurfaceView with no country listed", () => {
  it("hides every token surface when the switch is off, and reads nothing", async () => {
    delete process.env[NEW_TOKEN_SURFACES_ENV];
    await expect(getTokenSurfaceView()).resolves.toEqual({ tokenSurfaces: false, geoBlocked: false });
    process.env[NEW_TOKEN_SURFACES_ENV] = "off";
    await expect(getTokenSurfaceView()).resolves.toEqual({ tokenSurfaces: false, geoBlocked: false });
    expect(mockHeaders).not.toHaveBeenCalled();
  });

  it("shows the token surfaces when the switch is on, still without reading the request", async () => {
    for (const value of ["1", "true", "on", "yes"]) {
      process.env[NEW_TOKEN_SURFACES_ENV] = value;
      await expect(getTokenSurfaceView()).resolves.toEqual({ tokenSurfaces: true, geoBlocked: false });
    }
    expect(mockHeaders).not.toHaveBeenCalled();
  });
});

describe("tokenSurfacesVisible", () => {
  it.each<[TokenSurfaceView, boolean]>([
    [{ tokenSurfaces: true, geoBlocked: false }, true],
    [{ tokenSurfaces: true, geoBlocked: true }, false],
    [{ tokenSurfaces: false, geoBlocked: false }, false],
    [{ tokenSurfaces: false, geoBlocked: true }, false],
  ])("%j -> %s", (view, expected) => {
    expect(tokenSurfacesVisible(view)).toBe(expected);
  });
});
