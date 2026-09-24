/**
 * Token geo-policy: the ONE place that decides which countries may not use
 * Hivra's token features.
 *
 * It ships DORMANT. While `blockedCountries` is empty nothing reads a country,
 * no request or query is made for it, and every page and route behaves exactly
 * as it did before the gate existed.
 *
 * Enabling it is one reviewed PR that adds ISO-3166 alpha-2 codes, for example
 * `blockedCountries: ["GB"]`. Read docs/token/TOKEN-GEO-POLICY.md first: it
 * lists what gets blocked, what never changes for existing users, the legal
 * review this needs, and how to verify it after the merge.
 *
 * Client-safe: no imports. The server decides (lib/compliance/token-geo-gate.ts);
 * the client only uses `isTokenGeoPolicyActive()` to skip asking when the list
 * is empty.
 */
export interface TokenGeoPolicy {
  /** ISO-3166 alpha-2 codes, upper case, e.g. "GB". Empty = dormant. */
  blockedCountries: readonly string[];
}

export const TOKEN_GEO_POLICY: TokenGeoPolicy = {
  blockedCountries: [],
};

/** Error code on every 403 the gate returns. */
export const TOKEN_GEO_BLOCKED_CODE = "token_geo_blocked";

const ALPHA2 = /^[A-Z]{2}$/;

/**
 * Normalises a country signal to an upper-case ISO-3166 alpha-2 code, or null.
 * Vercel sends "XX" for an unknown IP and "T1" for Tor; neither is a country.
 */
export function normalizeCountryCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  if (!ALPHA2.test(code) || code === "XX") return null;
  return code;
}

export function isTokenGeoPolicyActive(policy: TokenGeoPolicy = TOKEN_GEO_POLICY): boolean {
  return policy.blockedCountries.length > 0;
}

export function isCountryBlockedForTokens(
  country: unknown,
  policy: TokenGeoPolicy = TOKEN_GEO_POLICY
): boolean {
  const code = normalizeCountryCode(country);
  if (!code) return false;
  return policy.blockedCountries.some((blocked) => normalizeCountryCode(blocked) === code);
}

// English short names that read with "the" ("people in the United Kingdom").
const NAMES_WITH_ARTICLE = new Set([
  "AE", "BS", "CF", "CK", "DO", "FK", "FO", "GB", "GM", "KM", "KY", "MH", "MV", "NL",
  "PH", "SB", "SC", "TC", "US", "VG", "VI",
]);

/** "the United Kingdom" for GB; the code itself when no name is known. */
export function tokenGeoCountryName(country: string): string {
  const code = normalizeCountryCode(country) ?? country;
  let name: string | undefined;
  try {
    name = new Intl.DisplayNames(["en"], { type: "region" }).of(code);
  } catch {
    name = undefined;
  }
  if (!name || name === code || name === "Unknown Region") return code;
  return NAMES_WITH_ARTICLE.has(code) ? `the ${name}` : name;
}

/** The notice shown on token pages and returned with every refusal. */
export function tokenGeoNotice(country: string): string {
  return `Token features aren't available to people in ${tokenGeoCountryName(country)}.`;
}
