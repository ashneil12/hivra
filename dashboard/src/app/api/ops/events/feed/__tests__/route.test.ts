/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

interface FakeOpsEvent {
  id: string;
  severity: "info" | "warn" | "error" | "fatal";
  source: string;
  title: string;
  last_seen_at: string;
  archived_at: string | null;
}

let rowsForRun: FakeOpsEvent[] = [];
let queryError: { message: string } | null = null;
const lastFilters: Record<string, unknown> = {};

function resetSpy() {
  for (const k of Object.keys(lastFilters)) delete lastFilters[k];
}

function makeQuery() {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (col: string, val: unknown) => {
      lastFilters[`eq_${col}`] = val;
      return q;
    },
    gt: (col: string, val: unknown) => {
      lastFilters[`gt_${col}`] = val;
      return q;
    },
    is: (col: string, val: unknown) => {
      lastFilters[`is_${col}`] = val;
      return q;
    },
    order: () => q,
    limit: async () => ({ data: rowsForRun, error: queryError }),
  };
  return q;
}

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => makeQuery() },
}));

import { GET } from "../route";

const originalCronSecret = process.env.CRON_SECRET;

function req(query = "", secret = "test-secret") {
  const url = `http://localhost/api/ops/events/feed${query ? "?" + query : ""}`;
  return new NextRequest(url, {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

beforeEach(() => {
  rowsForRun = [];
  queryError = null;
  resetSpy();
  process.env.CRON_SECRET = "test-secret";
});

afterEach(() => {
  if (originalCronSecret === undefined) {
    delete process.env.CRON_SECRET;
  } else {
    process.env.CRON_SECRET = originalCronSecret;
  }
});

describe("GET /api/ops/events/feed", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(req("", "wrong-secret"));
    expect(response.status).toBe(401);
  });

  it("returns 500 when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(req());
    expect(response.status).toBe(500);
  });

  it("returns recent unarchived ops events with a nextSince cursor", async () => {
    rowsForRun = [
      {
        id: "evt_3",
        severity: "warn",
        source: "managed-venice-reconciliation",
        title: "Drift detected",
        last_seen_at: "2026-05-17T10:00:00Z",
        archived_at: null,
      },
      {
        id: "evt_2",
        severity: "error",
        source: "managed-venice-chat",
        title: "Refund failed",
        last_seen_at: "2026-05-17T09:30:00Z",
        archived_at: null,
      },
    ];

    const response = await GET(req());
    const body = (await response.json()) as {
      data: { count: number; nextSince: string | null; events: FakeOpsEvent[] };
    };

    expect(response.status).toBe(200);
    expect(body.data.count).toBe(2);
    expect(body.data.nextSince).toBe("2026-05-17T10:00:00Z");
    expect(body.data.events[0].id).toBe("evt_3");
    // Default behavior: archived events filtered out.
    expect(lastFilters.is_archived_at).toBeNull();
  });

  it("respects since cursor, severity, source filters", async () => {
    rowsForRun = [];
    await GET(
      req("since=2026-05-17T08:00:00Z&severity=warn&source=managed-venice-reconciliation"),
    );

    expect(lastFilters.gt_last_seen_at).toBe("2026-05-17T08:00:00.000Z");
    expect(lastFilters.eq_severity).toBe("warn");
    expect(lastFilters.eq_source).toBe("managed-venice-reconciliation");
  });

  it("includes archived events when include_archived=true", async () => {
    rowsForRun = [];
    await GET(req("include_archived=true"));
    // No is_archived_at filter applied when including archived.
    expect(lastFilters.is_archived_at).toBeUndefined();
  });

  it("clamps limit to MAX_LIMIT and ignores invalid severities", async () => {
    rowsForRun = [];
    await GET(req("limit=5000&severity=banana"));
    // limit clamps silently; invalid severity drops the filter entirely.
    expect(lastFilters.eq_severity).toBeUndefined();
  });

  it("returns nextSince=null when no events are returned and no since cursor was passed", async () => {
    rowsForRun = [];
    const response = await GET(req());
    const body = (await response.json()) as { data: { nextSince: string | null } };
    expect(body.data.nextSince).toBeNull();
  });

  it("preserves the since cursor when no events are returned but one was requested", async () => {
    rowsForRun = [];
    const response = await GET(req("since=2026-05-17T08:00:00Z"));
    const body = (await response.json()) as { data: { nextSince: string | null } };
    expect(body.data.nextSince).toBe("2026-05-17T08:00:00.000Z");
  });

  it("returns 500 when the supabase query errors", async () => {
    queryError = { message: "db unreachable" };
    const response = await GET(req());
    expect(response.status).toBe(500);
  });
});
