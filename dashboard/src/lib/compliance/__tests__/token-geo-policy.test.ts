import {
  TOKEN_GEO_POLICY,
  isCountryBlockedForTokens,
  isTokenGeoPolicyActive,
  normalizeCountryCode,
  tokenGeoCountryName,
  tokenGeoNotice,
} from "../token-geo-policy";

describe("token geo-policy", () => {
  /** The build-time check on the committed list: canonical alpha-2 codes of real regions, each once. */
  function listProblems(list: readonly string[]): string[] {
    const problems: string[] = [];
    for (const code of list) {
      if (!/^[A-Z]{2}$/.test(code)) problems.push(`${code}: not an upper-case alpha-2 code`);
      else if (normalizeCountryCode(code) !== code) problems.push(`${code}: use ${normalizeCountryCode(code)}`);
      else if (tokenGeoCountryName(code) === code) problems.push(`${code}: not a known region`);
    }
    if (new Set(list).size !== list.length) problems.push("duplicate entries");
    return problems;
  }

  it("lists only canonical ISO-3166 alpha-2 codes of real regions, each once", () => {
    // Guards the one-line enabling change: a typo would silently block nobody.
    const real = jest.requireActual<typeof import("../token-geo-list")>("../token-geo-list").BLOCKED_COUNTRIES;
    expect(listProblems(real)).toEqual([]);
    expect(listProblems(TOKEN_GEO_POLICY.blockedCountries)).toEqual([]);
  });

  it("would fail the build on 'UK', 'gb', 'GBR', an unknown region or a duplicate", () => {
    expect(listProblems(["GB"])).toEqual([]);
    expect(listProblems(["UK"])).toEqual(["UK: use GB"]);
    expect(listProblems(["gb"])).toEqual(["gb: not an upper-case alpha-2 code"]);
    expect(listProblems(["GBR"])).toEqual(["GBR: not an upper-case alpha-2 code"]);
    expect(listProblems(["ZZ"])).toEqual(["ZZ: not a known region"]);
    expect(listProblems(["GB", "GB"])).toEqual(["duplicate entries"]);
  });

  it("with an empty list is dormant and blocks no country", () => {
    const empty = { blockedCountries: [] };
    expect(isTokenGeoPolicyActive(empty)).toBe(false);
    for (const country of ["GB", "US", "FR", "gb", "XX"]) {
      expect(isCountryBlockedForTokens(country, empty)).toBe(false);
    }
  });

  it("blocks exactly the listed countries, whatever the case of the signal", () => {
    const gb = { blockedCountries: ["GB"] };
    expect(isTokenGeoPolicyActive(gb)).toBe(true);
    expect(isCountryBlockedForTokens("GB", gb)).toBe(true);
    expect(isCountryBlockedForTokens(" gb ", gb)).toBe(true);
    expect(isCountryBlockedForTokens("US", gb)).toBe(false);
    expect(isCountryBlockedForTokens("IE", gb)).toBe(false);
    // Clerk records some session countries by English name.
    expect(isCountryBlockedForTokens("United Kingdom", gb)).toBe(true);
    expect(isCountryBlockedForTokens("united kingdom", gb)).toBe(true);
    expect(isCountryBlockedForTokens("Ireland", gb)).toBe(false);
    // A deprecated alias in the list still means GB at runtime.
    expect(isCountryBlockedForTokens("GB", { blockedCountries: ["UK"] })).toBe(true);
  });

  it("never treats an unknown or missing country as a country", () => {
    const gb = { blockedCountries: ["GB"] };
    for (const raw of [null, undefined, "", "  ", "XX", "T1", "GBR", 44]) {
      expect(normalizeCountryCode(raw)).toBeNull();
      expect(isCountryBlockedForTokens(raw, gb)).toBe(false);
    }
  });

  it("words the notice for the United Kingdom", () => {
    expect(tokenGeoNotice("GB")).toBe("Token features aren't available to people in the United Kingdom.");
    expect(tokenGeoNotice("DE")).toBe("Token features aren't available to people in Germany.");
    expect(tokenGeoNotice("US")).toBe("Token features aren't available to people in the United States.");
  });
});

describe("the policy reads the country list file", () => {
  // Every other suite runs with an empty list (jest.setup.tsx), so without this
  // nothing fails if the policy stops reading the list at all.
  it("takes blockedCountries from whatever token-geo-list.ts exports", () => {
    // resetModules, not isolateModules: an isolated registry still answers from
    // the already-created mock of the list, so it would see the empty list.
    jest.resetModules();
    try {
      jest.doMock("../token-geo-list", () => ({ BLOCKED_COUNTRIES: ["FR", "DE"] }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fresh = require("../token-geo-policy") as typeof import("../token-geo-policy");
      expect(fresh.TOKEN_GEO_POLICY.blockedCountries).toEqual(["FR", "DE"]);
      expect(fresh.isTokenGeoPolicyActive()).toBe(true);
      expect(fresh.isCountryBlockedForTokens("FR")).toBe(true);
      expect(fresh.isCountryBlockedForTokens("GB")).toBe(false);
    } finally {
      jest.doMock("../token-geo-list", () => ({ BLOCKED_COUNTRIES: [] }));
      jest.resetModules();
    }
  });
});

describe("the committed country list", () => {
  it("blocks the United Kingdom", () => {
    const real = jest.requireActual<typeof import("../token-geo-list")>("../token-geo-list").BLOCKED_COUNTRIES;
    expect(real).toContain("GB");
  });
});
