/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";

const mockReportOpsEvent = jest.fn();

// Route-visible fixture state, mutated per test.
let reservationCounts = { attempts: 0, captured: 0 };
let opsEventRow: { last_seen_at: string } | null = null;
let opsEventLookupError: { message: string } | null = null;

jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "managed_venice_reservations") {
        return {
          select: () => {
            let capturedOnly = false;
            const chain = {
              eq: (col: string, val: string) => {
                if (col === "status" && val === "captured") capturedOnly = true;
                return chain;
              },
              gte: () => chain,
              lt: () => chain,
              then: (resolve: (value: unknown) => unknown) =>
                Promise.resolve({
                  count: capturedOnly
                    ? reservationCounts.captured
                    : reservationCounts.attempts,
                  error: null,
                }).then(resolve),
            };
            return chain;
          },
        };
      }
      if (table === "ops_events") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: opsEventRow, error: opsEventLookupError }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  },
}));

jest.mock("@/lib/ops-events", () => {
  const actual = jest.requireActual("@/lib/ops-events");
  return {
    ...actual,
    reportOpsEvent: (...args: unknown[]) => mockReportOpsEvent(...args),
  };
});

import { GET } from "../route";

const originalFetch = global.fetch;
const originalCronSecret = process.env.CRON_SECRET;
const originalApiKey = process.env.VENICE_API_KEY;
const originalInferenceKeys = process.env.MANAGED_VENICE_INFERENCE_KEYS;

function mockReq(secret = "test-cron-secret") {
  return new NextRequest("http://localhost/api/cron/managed-venice-health", {
    method: "GET",
    headers: { authorization: `Bearer ${secret}` },
  });
}

function healthyProbeResponse(balanceUsd = 100) {
  return new Response(
    JSON.stringify({ data: { accessPermitted: true, balances: { USD: balanceUsd, DIEM: 0 } } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

interface RouteBody {
  data: {
    drought: { level: string; attempts: number; captured: number };
    probe: { status: string; httpStatus: number | null; balanceUsd: number | null };
    events: Array<{ title: string; severity: string; deduped: boolean }>;
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.VENICE_API_KEY = "venice_test_key";
  delete process.env.MANAGED_VENICE_INFERENCE_KEYS;
  reservationCounts = { attempts: 0, captured: 0 };
  opsEventRow = null;
  opsEventLookupError = null;
  global.fetch = jest.fn().mockResolvedValue(healthyProbeResponse());
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const [key, value] of [
    ["CRON_SECRET", originalCronSecret],
    ["VENICE_API_KEY", originalApiKey],
    ["MANAGED_VENICE_INFERENCE_KEYS", originalInferenceKeys],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("GET /api/cron/managed-venice-health", () => {
  it("rejects requests without the cron bearer", async () => {
    const response = await GET(mockReq("wrong-secret"));
    expect(response.status).toBe(401);
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("500s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(mockReq());
    expect(response.status).toBe(500);
  });

  it("emits NOTHING on the healthy path (traffic capturing, probe green)", async () => {
    reservationCounts = { attempts: 12, captured: 11 };

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(response.status).toBe(200);
    expect(body.data.drought.level).toBe("healthy");
    expect(body.data.probe.status).toBe("healthy");
    expect(body.data.probe.balanceUsd).toBe(100);
    expect(body.data.events).toHaveLength(0);
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("stays quiet on an idle window (no attempts at all)", async () => {
    reservationCounts = { attempts: 0, captured: 0 };

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(body.data.drought.level).toBe("healthy");
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("emits a fatal ops event on a capture drought (attempts, zero captures)", async () => {
    reservationCounts = { attempts: 8, captured: 0 };

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(response.status).toBe(200);
    expect(body.data.drought.level).toBe("critical");
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    const event = mockReportOpsEvent.mock.calls[0][0];
    expect(event.severity).toBe("fatal");
    expect(event.source).toBe("cron/managed-venice-health");
    expect(event.metadata).toMatchObject({
      failureType: "managed_venice_capture_drought",
      attempts: 8,
      captured: 0,
    });
    expect(body.data.events).toEqual([
      expect.objectContaining({ severity: "fatal", deduped: false }),
    ]);
  });

  it("emits a warn ops event on a degraded capture ratio", async () => {
    reservationCounts = { attempts: 10, captured: 1 }; // 10% < 25%

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(body.data.drought.level).toBe("warn");
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    expect(mockReportOpsEvent.mock.calls[0][0].severity).toBe("warn");
    expect(mockReportOpsEvent.mock.calls[0][0].metadata.failureType).toBe(
      "managed_venice_capture_ratio_degraded"
    );
  });

  it("emits a fatal ops event when the upstream probe 402s", async () => {
    reservationCounts = { attempts: 12, captured: 11 }; // drought healthy
    global.fetch = jest.fn().mockResolvedValue(new Response("Payment Required", { status: 402 }));

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(body.data.drought.level).toBe("healthy");
    expect(body.data.probe.status).toBe("critical");
    expect(body.data.probe.httpStatus).toBe(402);
    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    const event = mockReportOpsEvent.mock.calls[0][0];
    expect(event.severity).toBe("fatal");
    expect(event.metadata.failureType).toBe("managed_venice_upstream_probe_failed");
    expect(event.metadata.httpStatus).toBe(402);
  });

  it("dedupes an identical CRITICAL already reported inside the window", async () => {
    reservationCounts = { attempts: 8, captured: 0 };
    // Same fingerprint last seen 1h ago — inside the 6h dedupe window.
    opsEventRow = { last_seen_at: new Date(Date.now() - 3_600_000).toISOString() };

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(response.status).toBe(200);
    expect(body.data.drought.level).toBe("critical");
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
    expect(body.data.events).toEqual([
      expect.objectContaining({ severity: "fatal", deduped: true }),
    ]);
  });

  it("re-emits when the last identical report is older than the dedupe window", async () => {
    reservationCounts = { attempts: 8, captured: 0 };
    opsEventRow = { last_seen_at: new Date(Date.now() - 7 * 3_600_000).toISOString() };

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
    expect(body.data.events).toEqual([
      expect.objectContaining({ severity: "fatal", deduped: false }),
    ]);
  });

  it("fails open and still emits when the dedupe lookup errors", async () => {
    reservationCounts = { attempts: 8, captured: 0 };
    opsEventLookupError = { message: "db hiccup" };

    await GET(mockReq());

    expect(mockReportOpsEvent).toHaveBeenCalledTimes(1);
  });

  it("skips the probe (no event) when no upstream key is configured", async () => {
    delete process.env.VENICE_API_KEY;
    reservationCounts = { attempts: 12, captured: 11 };
    global.fetch = jest.fn();

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(body.data.probe.status).toBe("skipped");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("treats an upstream 5xx as inconclusive — no page from a Venice wobble", async () => {
    reservationCounts = { attempts: 12, captured: 11 };
    global.fetch = jest.fn().mockResolvedValue(new Response("oops", { status: 500 }));

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(body.data.probe.status).toBe("inconclusive");
    expect(mockReportOpsEvent).not.toHaveBeenCalled();
  });

  it("can emit BOTH a drought fatal and a probe fatal in one run", async () => {
    reservationCounts = { attempts: 8, captured: 0 };
    global.fetch = jest.fn().mockResolvedValue(new Response("Payment Required", { status: 402 }));

    const response = await GET(mockReq());
    const body = (await response.json()) as RouteBody;

    expect(mockReportOpsEvent).toHaveBeenCalledTimes(2);
    expect(body.data.events).toHaveLength(2);
    const failureTypes = mockReportOpsEvent.mock.calls.map(
      ([arg]) => (arg as { metadata: { failureType: string } }).metadata.failureType
    );
    expect(failureTypes).toEqual(
      expect.arrayContaining([
        "managed_venice_capture_drought",
        "managed_venice_upstream_probe_failed",
      ])
    );
  });
});
