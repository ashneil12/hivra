/** @jest-environment jsdom */
import {
  CONSENT_STORAGE_KEY,
  CONSENT_VERSION,
  isConsentRequiredCountry,
  readStoredConsent,
  writeStoredConsent,
} from "../cookie-consent";

describe("isConsentRequiredCountry", () => {
  it("requires consent for EU / EEA / UK", () => {
    for (const c of ["DE", "FR", "GB", "NO", "IS", "LI", "IE", "ES", "PL"]) {
      expect(isConsentRequiredCountry(c)).toBe(true);
    }
  });

  it("does not require consent outside EU/UK (incl. Switzerland)", () => {
    for (const c of ["US", "CA", "AU", "JP", "BR", "CH", "IN"]) {
      expect(isConsentRequiredCountry(c)).toBe(false);
    }
  });

  it("fails safe: empty / null country requires consent", () => {
    // Only null/empty is the lib's fail-safe. Vercel's "XX"/"T1" unknown markers
    // are collapsed to null by /api/geo before this is called (see the route test).
    expect(isConsentRequiredCountry(null)).toBe(true);
    expect(isConsentRequiredCountry(undefined)).toBe(true);
    expect(isConsentRequiredCountry("")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isConsentRequiredCountry("de")).toBe(true);
    expect(isConsentRequiredCountry("us")).toBe(false);
  });
});

describe("consent persistence", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.cookie = `${CONSENT_STORAGE_KEY}=; Max-Age=0; Path=/`;
  });

  it("returns null when nothing is stored", () => {
    expect(readStoredConsent()).toBeNull();
  });

  it("round-trips accepted then rejected via localStorage", () => {
    writeStoredConsent("accepted");
    expect(readStoredConsent()?.choice).toBe("accepted");
    writeStoredConsent("rejected");
    expect(readStoredConsent()?.choice).toBe("rejected");
  });

  it("ignores a stored choice from an older consent version (re-prompts)", () => {
    window.localStorage.setItem(
      CONSENT_STORAGE_KEY,
      JSON.stringify({ choice: "accepted", version: CONSENT_VERSION - 1, timestamp: 1 })
    );
    expect(readStoredConsent()).toBeNull();
  });

  it("falls back to the cookie when localStorage has no choice", () => {
    const payload = JSON.stringify({
      choice: "accepted",
      version: CONSENT_VERSION,
      timestamp: 1,
    });
    document.cookie = `${CONSENT_STORAGE_KEY}=${encodeURIComponent(payload)}; Path=/`;
    expect(readStoredConsent()?.choice).toBe("accepted");
  });
});
