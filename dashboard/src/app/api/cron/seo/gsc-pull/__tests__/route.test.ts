/**
 * @jest-environment node
 */
import { generateKeyPairSync } from "node:crypto";

import { NextRequest } from "next/server";

const mockUpsert = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => ({
      upsert: (...args: unknown[]) => mockUpsert(...args),
    }),
  },
}));

import { GET } from "../route";

// A real (throwaway) RSA key so the route's JWT signing path runs for real;
// only the network is mocked.
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const SA_KEY_JSON = JSON.stringify({
  type: "service_account",
  client_email: "seo-bot@example-project.iam.gserviceaccount.com",
  private_key: privateKey,
});

const originalCronSecret = process.env.CRON_SECRET;
const originalSaKey = process.env.GSC_SA_KEY;

function req(secret = "test-cron-secret", query = "") {
  return new NextRequest(`http://localhost/api/cron/seo/gsc-pull${query}`, {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function tokenResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: "test-access-token", expires_in: 3600 }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "log").mockImplementation(() => {});
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.GSC_SA_KEY = SA_KEY_JSON;
  mockUpsert.mockResolvedValue({ error: null });
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.restoreAllMocks();
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
  if (originalSaKey === undefined) {
    delete process.env.GSC_SA_KEY;
  } else {
    process.env.GSC_SA_KEY = originalSaKey;
  }
});

describe("GET /api/cron/seo/gsc-pull", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(req("wrong-secret"));
    expect(response.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("responds 200 with gsc_key_missing when GSC_SA_KEY is unset", async () => {
    delete process.env.GSC_SA_KEY;

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ ok: false, reason: "gsc_key_missing" });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("responds 200 with gsc_permission_pending when GSC returns 403", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return { ok: false, status: 403, json: async () => ({}) };
    });

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(false);
    expect(body.data.reason).toBe("gsc_permission_pending");
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("upserts page+query rows for both sc-domain sites on success", async () => {
    const analyticsCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { body?: string }) => {
        if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
        analyticsCalls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}") });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            rows: [
              {
                keys: ["2026-07-12", "https://hivra.cloud/", "hivra"],
                clicks: 3,
                impressions: 40,
                ctr: 0.075,
                position: 4.2,
              },
            ],
          }),
        };
      },
    );

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(true);
    expect(body.data.totalUpserted).toBe(2);
    expect(analyticsCalls.map((c) => c.url)).toEqual([
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Ahivra.cloud/searchAnalytics/query",
      "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Ahermesos.cloud/searchAnalytics/query",
    ]);
    expect(analyticsCalls[0].body).toMatchObject({
      dimensions: ["date", "page", "query"],
      rowLimit: 25000,
      startRow: 0,
    });
    expect(mockUpsert).toHaveBeenCalledTimes(2);
    expect(mockUpsert.mock.calls[0][0]).toEqual([
      {
        date: "2026-07-12",
        site: "sc-domain:hivra.cloud",
        page: "https://hivra.cloud/",
        query: "hivra",
        clicks: 3,
        impressions: 40,
        ctr: 0.075,
        position: 4.2,
      },
    ]);
    expect(mockUpsert.mock.calls[0][1]).toEqual({ onConflict: "date,site,page,query" });
  });

  it("rejects a malformed date parameter", async () => {
    const response = await GET(req("test-cron-secret", "?date=07-12-2026"));
    expect(response.status).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("pulls a multi-day window when days is passed", async () => {
    let analyticsBody: Record<string, unknown> | null = null;
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { body?: string }) => {
        if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
        analyticsBody = JSON.parse(init?.body ?? "{}");
        return { ok: true, status: 200, json: async () => ({ rows: [] }) };
      },
    );

    const response = await GET(req("test-cron-secret", "?date=2026-07-10&days=7"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.startDate).toBe("2026-07-04");
    expect(body.data.endDate).toBe("2026-07-10");
    expect(analyticsBody).toMatchObject({ startDate: "2026-07-04", endDate: "2026-07-10" });
  });
});
