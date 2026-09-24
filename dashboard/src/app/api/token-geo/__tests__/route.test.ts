import { NextRequest } from "next/server";

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));

import { auth } from "@clerk/nextjs/server";

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { GET } from "../route";

function request(country?: string) {
  return new NextRequest("https://canary.hermesos.cloud/api/token-geo", {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_code: "GB" }, error: null }) }) }),
  }));
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe("GET /api/token-geo", () => {
  it("answers 'not blocked' with the dormant policy, reading neither auth nor the database", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
    const response = await GET(request("GB"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({ blocked: false, notice: null });
    expect(auth).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("with ['GB'] blocks a GB visitor with the notice, signed out", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    const response = await GET(request("GB"));
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      notice: "Token features aren't available to people in the United Kingdom.",
    });
  });

  it("with ['GB'] blocks a signed-in user whose stored country is GB, and allows others", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    await expect((await GET(request("US"))).json()).resolves.toMatchObject({ blocked: true });

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    await expect((await GET(request("US"))).json()).resolves.toEqual({ blocked: false, notice: null });
  });
});
