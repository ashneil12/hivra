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

// Keep the sweep small and deterministic: the real sitemap grows every time an
// article ships, and this suite asserts exact per-URL call counts.
jest.mock("@/lib/seo-urls", () => ({
  SITE_URL: "https://hivra.cloud",
  getSiteUrls: () => [
    { url: "https://hivra.cloud/" },
    { url: "https://hivra.cloud/pricing" },
  ],
}));

import { GET, siteProperty } from "../route";

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

function req(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/seo/index-coverage", {
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

function inspectionResponse(indexStatusResult: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ inspectionResult: { indexStatusResult } }),
  };
}

const INDEXED = {
  verdict: "PASS",
  coverageState: "Submitted and indexed",
  robotsTxtState: "ALLOWED",
  indexingState: "INDEXING_ALLOWED",
  pageFetchState: "SUCCESSFUL",
  googleCanonical: "https://hivra.cloud/",
  userCanonical: "https://hivra.cloud/",
  lastCrawlTime: "2026-07-20T10:00:00Z",
};

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

describe("siteProperty", () => {
  it("derives the sc-domain property from SITE_URL rather than hardcoding it", () => {
    expect(siteProperty()).toBe("sc-domain:hivra.cloud");
  });
});

describe("GET /api/cron/seo/index-coverage", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(req("wrong-secret"));
    expect(response.status).toBe(401);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("responds 200 with gsc_not_configured when GSC_SA_KEY is unset", async () => {
    delete process.env.GSC_SA_KEY;

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ ok: false, reason: "gsc_not_configured", checked: 0 });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("responds 200 with gsc_permission_pending and writes nothing when GSC returns 403", async () => {
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

  it("inspects every sitemap URL against the site property and upserts the rows", async () => {
    const inspected: string[] = [];
    (global.fetch as jest.Mock).mockImplementation(
      async (url: string, init?: { body?: string }) => {
        if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
        const payload = JSON.parse(init?.body ?? "{}");
        inspected.push(payload.inspectionUrl);
        expect(payload.siteUrl).toBe("sc-domain:hivra.cloud");
        expect(String(url)).toBe(
          "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect",
        );
        return inspectionResponse(INDEXED);
      },
    );

    const response = await GET(req());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.ok).toBe(true);
    expect(body.data.checked).toBe(2);
    expect(body.data.indexed).toBe(2);
    expect(body.data.notIndexed).toBe(0);
    expect(inspected.sort()).toEqual(["https://hivra.cloud/", "https://hivra.cloud/pricing"]);

    const [rows, options] = mockUpsert.mock.calls[0];
    expect(options).toEqual({ onConflict: "url" });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      site: "sc-domain:hivra.cloud",
      verdict: "PASS",
      coverage_state: "Submitted and indexed",
      last_crawl_time: "2026-07-20T10:00:00Z",
    });
    // first_seen must never be in the payload — it has a DB default and the
    // upsert would otherwise reset it on every sweep.
    expect(rows[0]).not.toHaveProperty("first_seen");
  });

  it("counts unindexed pages separately from indexed ones", async () => {
    let call = 0;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      call += 1;
      return call === 1
        ? inspectionResponse(INDEXED)
        : inspectionResponse({
            verdict: "FAIL",
            coverageState: "Crawled - currently not indexed",
            robotsTxtState: "ALLOWED",
          });
    });

    const body = await (await GET(req())).json();

    expect(body.data.indexed).toBe(1);
    expect(body.data.notIndexed).toBe(1);
  });

  it("flags a Google-vs-declared canonical mismatch", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return inspectionResponse({
        ...INDEXED,
        googleCanonical: "https://hivra.cloud/other",
        userCanonical: "https://hivra.cloud/pricing",
      });
    });

    const body = await (await GET(req())).json();

    expect(body.data.canonicalMismatch).toBe(2);
  });

  it("does not flag a trailing-slash-only canonical difference", async () => {
    // The first live sweep flagged the homepage purely because getSiteUrls()
    // emits "https://hivra.cloud" while the page declares the slashed form.
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return inspectionResponse({
        ...INDEXED,
        googleCanonical: "https://hivra.cloud",
        userCanonical: "https://hivra.cloud/",
      });
    });

    const body = await (await GET(req())).json();

    expect(body.data.canonicalMismatch).toBe(0);
  });

  it("does not flag when either canonical is missing", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return inspectionResponse({
        verdict: "FAIL",
        coverageState: "Discovered - currently not indexed",
      });
    });

    const body = await (await GET(req())).json();

    expect(body.data.canonicalMismatch).toBe(0);
  });

  it("retries once on a 5xx and records the retried result", async () => {
    // Google's inspection endpoint returns sporadic 500s; the first live sweep
    // lost 2 of 68 URLs that way.
    let inspections = 0;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      inspections += 1;
      if (inspections === 1) return { ok: false, status: 500, json: async () => ({}) };
      return inspectionResponse(INDEXED);
    });

    const body = await (await GET(req())).json();

    expect(body.data.failed).toBe(0);
    expect(body.data.indexed).toBe(2);
    // 2 URLs + 1 retry.
    expect(inspections).toBe(3);
  });

  it("gives up after one retry so a persistent 5xx cannot loop", async () => {
    let inspections = 0;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      inspections += 1;
      return { ok: false, status: 503, json: async () => ({}) };
    });

    const body = await (await GET(req())).json();

    expect(body.data.failed).toBe(2);
    // 2 URLs x (1 attempt + 1 retry) — never more.
    expect(inspections).toBe(4);
  });

  it("does not retry a 429, which is property-wide and would burn quota", async () => {
    let inspections = 0;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      inspections += 1;
      return { ok: false, status: 429, json: async () => ({}) };
    });

    const body = await (await GET(req())).json();

    expect(body.data.quotaExhausted).toBe(true);
    expect(inspections).toBeLessThanOrEqual(2);
  });

  it("stops the sweep on a 429 instead of burning the rest of the daily quota", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return { ok: false, status: 429, json: async () => ({}) };
    });

    const body = await (await GET(req())).json();

    expect(body.data.ok).toBe(true);
    expect(body.data.quotaExhausted).toBe(true);
    expect(body.data.checked).toBe(0);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("records a per-URL failure without failing the whole sweep", async () => {
    // 400 is not retryable (only 5xx is), so this exercises the record-and-continue
    // path with exactly one attempt.
    let call = 0;
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      call += 1;
      if (call === 1) return { ok: false, status: 400, json: async () => ({}) };
      return inspectionResponse(INDEXED);
    });

    const body = await (await GET(req())).json();

    expect(body.data.ok).toBe(true);
    expect(body.data.failed).toBe(1);
    expect(body.data.checked).toBe(2);

    const [rows] = mockUpsert.mock.calls[0];
    const failedRow = rows.find((row: { notes: string | null }) => row.notes !== null);
    expect(failedRow.verdict).toBeNull();
    expect(failedRow.notes).toContain("inspection failed");
  });

  it("returns 500 when the upsert fails so the cron surfaces as red", async () => {
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes("oauth2.googleapis.com/token")) return tokenResponse();
      return inspectionResponse(INDEXED);
    });
    mockUpsert.mockResolvedValue({ error: { message: "boom" } });

    const response = await GET(req());

    expect(response.status).toBe(500);
  });
});
