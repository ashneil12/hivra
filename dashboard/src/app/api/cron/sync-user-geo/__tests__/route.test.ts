/** @jest-environment node */
import { NextRequest } from "next/server";

const mockUpsert = jest.fn();
const mockFrom = jest.fn();
const mockReportOpsEvent = jest.fn();

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));

jest.mock("@/lib/ops-events", () => ({
  reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
  sanitizeOpsMetadata: (m: Record<string, unknown> | undefined) => m ?? {},
}));

import { GET } from "../route";

const originalFetch = global.fetch;
const CREATED = Date.UTC(2026, 9, 1);

function cronRequest() {
  return new NextRequest("http://localhost/api/cron/sync-user-geo", {
    headers: { authorization: "Bearer cron-secret" },
  });
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

/** Serves Clerk pages and sessions. `pageTwoStatus` makes the second page fail. */
function mockClerk(page: Array<{ id: string; created_at: number }>, countries: Record<string, string>, pageTwoStatus = 200) {
  global.fetch = jest.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/users")) {
      if (url.searchParams.get("offset") === "0") return json(page);
      return new Response("upstream error", { status: pageTwoStatus });
    }
    if (url.pathname.endsWith("/sessions")) {
      const id = url.searchParams.get("user_id") ?? "";
      return json([{ latest_activity: { country: countries[id] } }]);
    }
    return new Response("unexpected", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  process.env.CLERK_SECRET_KEY = "clerk-key";
  mockUpsert.mockResolvedValue({ error: null });
  mockFrom.mockReturnValue({ upsert: mockUpsert });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe("GET /api/cron/sync-user-geo", () => {
  it("writes the user count and country distribution when every page and session read succeeds", async () => {
    mockClerk(
      [
        { id: "user_a", created_at: CREATED },
        { id: "user_b", created_at: CREATED },
      ],
      { user_a: "US", user_b: "Germany" },
    );

    const response = await GET(cronRequest());

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        total_users: 2,
        country_distribution: { US: 1, DE: 1 },
        distinct_countries: 2,
      }),
      { onConflict: "id" },
    );
  });

  it("does not overwrite the last good user counts when a later Clerk page fails", async () => {
    // A full first page means the list continues; the failed second page must not
    // be read as the end of the list, or the partial count would be written.
    const fullPage = Array.from({ length: 500 }, (_, i) => ({ id: `user_${i}`, created_at: CREATED }));
    mockClerk(fullPage, {}, 500);

    const response = await GET(cronRequest());
    const body = (await response.json()) as { data: { updated: boolean; degraded: boolean } };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ updated: false, degraded: true });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockReportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ failureType: "sync_user_geo_page_failed" }) }),
    );
  });
});
