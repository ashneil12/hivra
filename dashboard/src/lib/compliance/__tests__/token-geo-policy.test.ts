import {
  TOKEN_GEO_POLICY,
  isCountryBlockedForTokens,
  isTokenGeoPolicyActive,
  normalizeCountryCode,
  tokenGeoCountryName,
  tokenGeoNotice,
} from "../token-geo-policy";

describe("token geo-policy", () => {
  it("lists only upper-case ISO-3166 alpha-2 codes, each once", () => {
    // Guards the one-line enabling change: a typo ("UK", "gb", "GBR") would
    // silently block nobody.
    for (const code of TOKEN_GEO_POLICY.blockedCountries) {
      expect(code).toMatch(/^[A-Z]{2}$/);
      expect(normalizeCountryCode(code)).toBe(code);
      expect(tokenGeoCountryName(code)).not.toBe(code);
    }
    expect(new Set(TOKEN_GEO_POLICY.blockedCountries).size).toBe(TOKEN_GEO_POLICY.blockedCountries.length);
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
  });

  it("never treats an unknown or missing country as a country", () => {
    const gb = { blockedCountries: ["GB"] };
    for (const raw of [null, undefined, "", "XX", "T1", "GBR", "United Kingdom", 44]) {
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
