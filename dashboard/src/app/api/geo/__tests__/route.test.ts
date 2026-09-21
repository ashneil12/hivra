const mockHeaders = jest.fn();
jest.mock("next/headers", () => ({ headers: () => mockHeaders() }));

import { GET } from "../route";

function withCountry(country: string | null) {
  mockHeaders.mockResolvedValue({
    get: (k: string) => (k === "x-vercel-ip-country" ? country : null),
  });
}

describe("GET /api/geo", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns consentRequired=true for an EU country", async () => {
    withCountry("DE");
    expect(await (await GET()).json()).toEqual({ country: "DE", consentRequired: true });
  });

  it("returns consentRequired=false for a non-EU country", async () => {
    withCountry("US");
    expect(await (await GET()).json()).toEqual({ country: "US", consentRequired: false });
  });

  it("fails safe to consentRequired=true when the geo header is missing", async () => {
    withCountry(null);
    expect(await (await GET()).json()).toEqual({ country: null, consentRequired: true });
  });

  it("treats an invalid/unknown geo code as consent-required", async () => {
    withCountry("T1");
    expect(await (await GET()).json()).toEqual({ country: null, consentRequired: true });
  });

  it("treats Vercel's 'XX' unknown marker as consent-required", async () => {
    withCountry("XX");
    expect(await (await GET()).json()).toEqual({ country: null, consentRequired: true });
  });

  it("is never cached", async () => {
    withCountry("US");
    const res = await GET();
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
  });
});
