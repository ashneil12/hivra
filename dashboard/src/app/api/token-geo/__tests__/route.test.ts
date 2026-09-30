import { NextRequest } from "next/server";

// The blocked-country cases run against the COMMITTED country list, not the empty
// one jest.setup.tsx gives other suites, and never replace the policy for them:
// if the list stopped reaching this route, they would fail. The dormant case
// below still empties the policy on purpose.
jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

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

  it("with the committed list (GB) blocks a GB visitor with the notice, signed out", async () => {
    const response = await GET(request("GB"));
    await expect(response.json()).resolves.toEqual({
      blocked: true,
      notice: "Token features aren't available to people in the United Kingdom.",
      existingAccess: false,
    });
  });

  it("with the committed list (GB) blocks a signed-in user whose stored country is GB, and allows others", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_a" });
    await expect((await GET(request("US"))).json()).resolves.toMatchObject({ blocked: true });

    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    await expect((await GET(request("US"))).json()).resolves.toEqual({ blocked: false, notice: null });
  });

  it("with the committed list (GB) answers {blocked:false} to an ops admin from a UK IP with a stored UK country", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: ADMIN_ID });
    await expect((await GET(request("GB"))).json()).resolves.toEqual({ blocked: false, notice: null });
    expect(clerkFetch).not.toHaveBeenCalled();

    // Matched by verified primary email instead of user ID.
    delete process.env.OPS_ADMIN_USER_IDS;
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_b" });
    clerkPrimaryEmail(ADMIN_EMAIL);
    await expect((await GET(request("GB"))).json()).resolves.toEqual({ blocked: false, notice: null });
  });

  it("with the committed list (GB) still blocks a non-admin, and a signed-out visitor, from a UK IP", async () => {
    clerkPrimaryEmail("customer@example.test");
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_b" });
    await expect((await GET(request("GB"))).json()).resolves.toEqual({
      blocked: true,
      notice: "Token features aren't available to people in the United Kingdom.",
      existingAccess: false,
    });
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true });
  });
});

describe("GET /api/token-geo: existingAccess for a blocked user", () => {
  // A table-aware database: the stored sign-up country (what blocks a user whose IP
  // is elsewhere) plus the two reads behind hasExistingTokenHolderAccess.
  function database(options: {
    tierRows?: unknown[] | "error";
    wallets?: unknown[];
  }) {
    mockFrom.mockImplementation((table: string) => {
      if (table === "signup_risk_assessments") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_code: "GB" }, error: null }) }) }),
        };
      }
      if (table === "token_tier_qualifications") {
        return {
          select: () => ({
            eq: () => ({
              limit: async () =>
                options.tierRows === "error"
                  ? { data: null, error: { message: "boom" } }
                  : { data: options.tierRows ?? [], error: null },
            }),
          }),
        };
      }
      if (table === "user_wallets") {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ not: () => ({ limit: async () => ({ data: options.wallets ?? [], error: null }) }) }) }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    });
  }

  beforeEach(() => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_holder" });
  });

  it("says a blocked user with a tier row already holds access, so the wallet page can keep their panels", async () => {
    database({ tierRows: [{ id: "row_1" }] });
    await expect((await GET(request("GB"))).json()).resolves.toEqual({
      blocked: true,
      notice: "Token features aren't available to people in the United Kingdom.",
      existingAccess: true,
    });
  });

  it("says a blocked user with only a self-verified wallet holds access", async () => {
    database({ wallets: [{ verification_method: "signature", metadata: null }] });
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true, existingAccess: true });
  });

  it("says a blocked user with no tier row and no token wallet holds none", async () => {
    // A credit-deposit Bankr wallet every crypto payment provisions is not token access.
    database({ wallets: [{ verification_method: "bankr", metadata: { bankr: { purpose: "credit_deposit" } } }] });
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true, existingAccess: false });
  });

  it("answers false, and logs, when the holding cannot be read", async () => {
    database({ tierRows: "error" });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true, existingAccess: false });
    warn.mockRestore();
  });

  it("never reads the holding for a user who is not blocked, and adds no field to that answer", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user_abroad" });
    mockFrom.mockImplementation((table: string) => {
      if (table === "signup_risk_assessments") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { country_code: "US" }, error: null }) }) }),
        };
      }
      throw new Error(`a user who is not blocked must not cause a read of ${table}`);
    });
    await expect((await GET(request("US"))).json()).resolves.toEqual({ blocked: false, notice: null });
  });

  it("never reads the holding for a signed-out visitor", async () => {
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: null });
    mockFrom.mockImplementation((table: string) => {
      throw new Error(`a signed-out visitor must not cause a read of ${table}`);
    });
    await expect((await GET(request("GB"))).json()).resolves.toMatchObject({ blocked: true, existingAccess: false });
  });
});
