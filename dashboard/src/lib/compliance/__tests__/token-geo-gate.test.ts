import { NextRequest } from "next/server";

const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));
jest.mock("@/lib/logger", () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import {
  hasExistingTokenHolderAccess,
  hasExistingTokenTierRow,
  isNewTokenQualificationRefused,
  resolveTokenGeoBlock,
} from "../token-geo-gate";
import { tokenGeoBlockedResponse } from "../token-geo-response";
import { TOKEN_GEO_POLICY } from "../token-geo-policy";

const GB_NOTICE = "Token features aren't available to people in the United Kingdom.";

function request(country?: string) {
  return new NextRequest("https://canary.hermesos.cloud/api/x", {
    headers: country === undefined ? {} : { "x-vercel-ip-country": country },
  });
}

/** A chainable stand-in for the supabase query builder, resolving to `result`. */
function query(result: { data: unknown; error: unknown }) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "limit"]) builder[method] = jest.fn(() => builder);
  builder.maybeSingle = jest.fn(async () => result);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function storedCountry(country: string | null) {
  mockFrom.mockImplementation((table: string) => {
    if (table === "signup_risk_assessments") {
      return query({ data: country === null ? null : { country_code: country }, error: null });
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe("resolveTokenGeoBlock", () => {
  beforeEach(() => {
    mockFrom.mockReset();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("with the dormant (empty) policy", () => {
    beforeEach(() => {
      jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
    });

    it("blocks nobody and reads neither the header nor the database", async () => {
      storedCountry("GB");
      const headers = { get: jest.fn(() => "GB") };

      await expect(resolveTokenGeoBlock({ headers }, { userId: "user_gb" })).resolves.toEqual({ blocked: false });
      await expect(isNewTokenQualificationRefused("user_gb")).resolves.toBe(false);

      expect(headers.get).not.toHaveBeenCalled();
      expect(mockFrom).not.toHaveBeenCalled();
    });
  });

  describe("with a policy of ['GB']", () => {
    beforeEach(() => {
      jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", ["GB"]);
    });

    it("blocks a GB request IP without reading the stored country", async () => {
      storedCountry(null);
      await expect(resolveTokenGeoBlock(request("GB"), { userId: "user_a" })).resolves.toEqual({
        blocked: true,
        country: "GB",
        signal: "ip_country",
        message: GB_NOTICE,
      });
      expect(mockFrom).not.toHaveBeenCalled();
    });

    it("blocks a user whose stored country is GB from a non-UK IP", async () => {
      storedCountry("gb");
      await expect(resolveTokenGeoBlock(request("US"), { userId: "user_a" })).resolves.toEqual({
        blocked: true,
        country: "GB",
        signal: "stored_country",
        message: GB_NOTICE,
      });
    });

    it("does not block another country, or a missing / unknown IP country without a stored GB", async () => {
      storedCountry("FR");
      for (const country of ["FR", undefined, "XX", "T1", ""]) {
        await expect(resolveTokenGeoBlock(request(country), { userId: "user_a" })).resolves.toEqual({ blocked: false });
      }
      // Signed out: only the header counts.
      await expect(resolveTokenGeoBlock(request("US"), null)).resolves.toEqual({ blocked: false });
      await expect(resolveTokenGeoBlock(undefined, null)).resolves.toEqual({ blocked: false });
    });

    it("treats a failed stored-country read as unknown, not as blocked", async () => {
      mockFrom.mockImplementation(() => query({ data: null, error: { code: "57014" } }));
      await expect(resolveTokenGeoBlock(request("US"), { userId: "user_a" })).resolves.toEqual({ blocked: false });
      mockFrom.mockImplementation(() => {
        throw new Error("connection reset");
      });
      await expect(resolveTokenGeoBlock(request("US"), { userId: "user_a" })).resolves.toEqual({ blocked: false });
    });

    it("refuses a new qualification from the caller's decision, or else the stored country", async () => {
      storedCountry(null);
      await expect(
        isNewTokenQualificationRefused("user_a", await resolveTokenGeoBlock(request("GB"), { userId: "user_a" }))
      ).resolves.toBe(true);
      await expect(isNewTokenQualificationRefused("user_a", { blocked: false })).resolves.toBe(false);
      // Crons pass no decision: the stored country decides.
      await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
      storedCountry("GB");
      await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(true);
    });

    describe("with no request (crons): Clerk's latest-session country stands in for the IP", () => {
      const originalKey = process.env.CLERK_SECRET_KEY;
      const originalFetch = global.fetch;
      const fetchMock = jest.fn();
      beforeEach(() => {
        process.env.CLERK_SECRET_KEY = "sk_test_geo";
        fetchMock.mockReset();
        global.fetch = fetchMock as unknown as typeof fetch;
      });
      afterEach(() => {
        global.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.CLERK_SECRET_KEY;
        else process.env.CLERK_SECRET_KEY = originalKey;
      });
      function session(country: unknown, ok = true) {
        fetchMock.mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => [{ latest_activity: { country } }] });
      }

      it("refuses when the latest session was in the UK, by code or by name", async () => {
        storedCountry(null);
        session("United Kingdom");
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(true);
        session("GB");
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
          "https://api.clerk.com/v1/sessions?user_id=user_a&limit=1",
          expect.objectContaining({ headers: { Authorization: "Bearer sk_test_geo" } }),
        );
      });

      it("allows another country, and treats a failed or empty read as unknown", async () => {
        storedCountry(null);
        session("France");
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
        session("GB", false);
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
        fetchMock.mockRejectedValue(new Error("timeout"));
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
        fetchMock.mockResolvedValue({ ok: true, json: async () => [] });
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
      });

      it("isn't asked when a request decision exists or the stored country already refuses", async () => {
        storedCountry("GB");
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(true);
        await expect(isNewTokenQualificationRefused("user_a", { blocked: false })).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("is never asked with the dormant policy", async () => {
        jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
        session("GB");
        await expect(isNewTokenQualificationRefused("user_a")).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    it("returns a 403 with a clear code and the user-facing notice", async () => {
      const decision = await resolveTokenGeoBlock(request("GB"), null);
      if (!decision.blocked) throw new Error("expected a block");
      const response = tokenGeoBlockedResponse(decision, {
        source: "test",
        route: "/api/test",
        method: "POST",
        userId: "user_a",
      });
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: GB_NOTICE,
        code: "token_geo_blocked",
        reason: "token_geo_blocked",
        country: "GB",
      });
    });
  });
});

describe("hasExistingTokenHolderAccess", () => {
  function tables(qualifications: unknown[], wallets: unknown[]) {
    mockFrom.mockImplementation((table: string) => {
      if (table === "token_tier_qualifications") return query({ data: qualifications, error: null });
      if (table === "user_wallets") return query({ data: wallets, error: null });
      throw new Error(`unexpected table ${table}`);
    });
  }

  it("is true for any tier qualification row, whatever its state", async () => {
    tables([{ id: "q1" }], []);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(true);
  });

  it("is true for a self-verified wallet or a legacy lock wallet", async () => {
    tables([], [{ verification_method: "signature", metadata: {} }]);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(true);
    tables([], [{ verification_method: "bankr", metadata: { bankr: { purpose: "hermesos_lock" } } }]);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(true);
    // Older Bankr holder wallets carry no purpose; they count as token wallets too.
    tables([], [{ verification_method: "bankr", metadata: {} }]);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(true);
  });

  it("is false for a new user, including one who only has a crypto-payment deposit address", async () => {
    tables([], []);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(false);
    tables([], [{ verification_method: "bankr", metadata: { bankr: { purpose: "credit_deposit" } } }]);
    await expect(hasExistingTokenHolderAccess("user_a")).resolves.toBe(false);
  });

  it("throws when it cannot read, rather than guessing", async () => {
    mockFrom.mockImplementation(() => query({ data: null, error: { code: "57014" } }));
    await expect(hasExistingTokenHolderAccess("user_a")).rejects.toThrow("Failed to read token tier qualifications");
    await expect(hasExistingTokenTierRow("user_a", "pro")).rejects.toThrow("Failed to read token tier qualifications");
  });

  it("hasExistingTokenTierRow reads the user's row for that tier", async () => {
    tables([{ id: "q1" }], []);
    await expect(hasExistingTokenTierRow("user_a", "pro")).resolves.toBe(true);
    tables([], []);
    await expect(hasExistingTokenTierRow("user_a", "power")).resolves.toBe(false);
  });
});
