/** @jest-environment node */

import { trustedClientAddress, trustedClientAddressHeader } from "../trusted-client-address";
import { trustedAppOrigin, validateTrustedAppOrigin } from "../trusted-app-origin";

const VERCEL = { VERCEL: "1" };
const request = (headers: Record<string, string>) => new Request("https://hivra.example/api/x", { method: "POST", headers });

describe("trustedClientAddress (T16, T37)", () => {
  it("reads Vercel's own header on Vercel", () => {
    expect(trustedClientAddressHeader(VERCEL)).toBe("x-vercel-forwarded-for");
    expect(trustedClientAddress(request({ "x-vercel-forwarded-for": "203.0.113.7" }), VERCEL))
      .toEqual({ address: "203.0.113.7", family: 4 });
    expect(trustedClientAddress(request({ "x-vercel-forwarded-for": "2001:DB8::1" }), VERCEL))
      .toEqual({ address: "2001:db8::1", family: 6 });
    expect(trustedClientAddress(request({ "x-vercel-forwarded-for": "::ffff:203.0.113.8" }), VERCEL))
      .toEqual({ address: "203.0.113.8", family: 4 });
  });

  it("ignores spoofed cf-connecting-ip, x-real-ip and x-forwarded-for", () => {
    const spoofed = { "cf-connecting-ip": "198.51.100.1", "x-real-ip": "198.51.100.2", "x-forwarded-for": "198.51.100.3" };
    expect(trustedClientAddress(request(spoofed), VERCEL)).toEqual({ address: null, family: null, reason: "missing" });
    expect(trustedClientAddress(request({ ...spoofed, "x-vercel-forwarded-for": "203.0.113.9" }), VERCEL))
      .toEqual({ address: "203.0.113.9", family: 4 });
  });

  it("treats a comma list or a non-address as not seen", () => {
    expect(trustedClientAddress(request({ "x-vercel-forwarded-for": "198.51.100.1, 203.0.113.9" }), VERCEL))
      .toMatchObject({ address: null, reason: "list" });
    for (const value of ["not-an-ip", "203.0.113.9:22", "[2001:db8::1]", "203.0.113.256"]) {
      expect(trustedClientAddress(request({ "x-vercel-forwarded-for": value }), VERCEL))
        .toMatchObject({ address: null, reason: "invalid" });
    }
  });

  it("treats a Cloudflare edge as not seen, so the card never names the edge", () => {
    for (const edge of ["104.16.1.1", "172.64.0.10", "162.158.4.4", "2606:4700::1111", "2a06:98c1::5"]) {
      expect(trustedClientAddress(request({ "x-vercel-forwarded-for": edge }), VERCEL))
        .toEqual({ address: null, family: null, reason: "cloudflare_edge" });
    }
    expect(trustedClientAddress(request({ "x-vercel-forwarded-for": "104.15.255.255" }), VERCEL))
      .toEqual({ address: "104.15.255.255", family: 4 });
  });

  it("reads nothing off Vercel unless a self-hosted operator names one header", () => {
    const headers = { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "203.0.113.8", "x-client": "203.0.113.9" };
    expect(trustedClientAddressHeader({})).toBeNull();
    expect(trustedClientAddress(request(headers), {})).toMatchObject({ address: null, reason: "not_configured" });
    expect(trustedClientAddress(request(headers), { HIVRA_TRUSTED_CLIENT_ADDRESS_HEADER: "X-Client" }))
      .toEqual({ address: "203.0.113.9", family: 4 });
    expect(trustedClientAddressHeader({ HIVRA_TRUSTED_CLIENT_ADDRESS_HEADER: "bad header!" })).toBeNull();
  });
});

describe("trusted app origin", () => {
  it("accepts a bare lowercase https origin", () => {
    expect(validateTrustedAppOrigin("https://canary.hermesos.cloud")).toBe("https://canary.hermesos.cloud");
    expect(trustedAppOrigin({ NEXT_PUBLIC_APP_URL: " https://hivra.cloud " })).toBe("https://hivra.cloud");
    expect(trustedAppOrigin({})).toBeNull();
  });

  it.each([
    "http://hivra.cloud", "https://hivra.cloud:443x", "https://hivra.cloud:8443", "https://a@hivra.cloud",
    "https://hivra.cloud/x", "https://hivra.cloud?x", "https://hivra.cloud#x", "https://hivra.cloud\\",
    "https://hivra.cloud ", "https://hivra.clöud", "https://hivra.cloud‮", "https://-hivra.cloud",
    "https://hivra..cloud", "https://hivra.cloud$", "https://hivra.cloud{", "",
  ])("refuses %p", origin => {
    expect(() => validateTrustedAppOrigin(origin)).toThrow();
    // The environment value is trimmed first; everything else is refused.
    if (origin.trim() === origin) expect(trustedAppOrigin({ NEXT_PUBLIC_APP_URL: origin })).toBeNull();
  });
});
