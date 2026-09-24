import { NextRequest } from "next/server";

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
// The real admin check, observed: the dormant policy must never reach it.
const mockIsOpsAdminUser = jest.fn();
jest.mock("@/lib/ops-access", () => {
  const actual = jest.requireActual("@/lib/ops-access");
  return { ...actual, isOpsAdminUser: (...args: unknown[]) => mockIsOpsAdminUser(...args) };
});

import { auth } from "@clerk/nextjs/server";

import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";
import { GET } from "../route";

function request(country?: string) {
  return new NextRequest("https://canary.hermesos.cloud/api/token-geo", {
    headers: country ? { "x-vercel-ip-country": country } : {},
  });
}

// Obviously fake admin identities: the repo is public and no real admin is named.
const ADMIN_ID = "user_ops_admin_test";
const ADMIN_EMAIL = "ops-admin@example.test";
const OPS_ENV_KEYS = ["OPS_ADMIN_USER_IDS", "OPS_ADMIN_EMAILS", "CLERK_SECRET_KEY"] as const;
const originalOpsEnv: Record<string, string | undefined> = {};
const originalFetch = global.fetch;
const clerkFetch = jest.fn();

function clerkPrimaryEmail(email: string) {
  clerkFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      primary_email_address_id: "idn_1",
      email_addresses: [{ id: "idn_1", email_address: email, verification: { status: "verified" } }],
    }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsOpsAdminUser.mockImplementation(jest.requireActual("@/lib/ops-access").isOpsAdminUser);
  for (const key of OPS_ENV_KEYS) originalOpsEnv[key] = process.env[key];
  process.env.OPS_ADMIN_USER_IDS = ADMIN_ID;
  process.env.OPS_ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.CLERK_SECRET_KEY = "sk_test_geo";
  clerkFetch.mockReset();
  global.fetch = clerkFetch as unknown as typeof fetch;
  (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
  mockFrom.mockImplementation(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_code: "GB" }, error: null }) }) }),
  }));
});
afterEach(() => {
  global.fetch = originalFetch;
  for (const key of OPS_ENV_KEYS) {
    if (originalOpsEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalOpsEnv[key];
  }
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
    // Ops admins are configured here, yet nothing looks one up.
    expect(mockIsOpsAdminUser).not.toHaveBeenCalled();
    expect(clerkFetch).not.toHaveBeenCalled();
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

  it("with ['GB'] answers {blocked:false} to an ops admin from a UK IP with a stored UK country", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: ADMIN_ID });
    await expect((await GET(request("GB"))).json()).resolves.toEqual({ blocked: false, notice: null });
    expect(clerkFetch).not.toHaveBeenCalled();

    // Matched by verified primary email instead of user ID.
    delete process.env.OPS_ADMIN_USER_IDS;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_b" });
    clerkPrimaryEmail(ADMIN_EMAIL);
    await expect((await GET(request("GB"))).json()).resolves.toEqual({ blocked: false, notice: null });
  });

  it("with ['GB'] still blocks a non-admin, and a signed-out visitor, from a UK IP", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    clerkPrimaryEmail("customer@example.test");
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_b" });
    await expect((await GET(request("GB"))).json()).resolves.toEqual({
      blocked: true,
      notice: "Token features aren't available to people in the United Kingdom.",
    });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true });
  });
});
