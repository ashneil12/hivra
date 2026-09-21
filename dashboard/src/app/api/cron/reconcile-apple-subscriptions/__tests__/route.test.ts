import { NextRequest } from "next/server";

describe("GET /api/cron/reconcile-apple-subscriptions", () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    process.env.CRON_SECRET = "cron-secret-test";
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
    consoleLogSpy.mockRestore();
    delete process.env.CRON_SECRET;
  });

  function createRequest(bearer: string | null = "cron-secret-test") {
    const headers = new Headers();
    if (bearer) headers.set("authorization", `Bearer ${bearer}`);
    return new NextRequest("http://localhost/api/cron/reconcile-apple-subscriptions", {
      method: "GET",
      headers,
    });
  }

  function mockDeps(overrides: Record<string, unknown> = {}) {
    const reconcile =
      (overrides.reconcile as jest.Mock) ??
      jest.fn().mockResolvedValue({
        scanned: 0,
        converged: 0,
        manualReview: 0,
        skipped: 0,
        errors: 0,
        entries: [],
      });
    const reportOpsEvent =
      (overrides.reportOpsEvent as jest.Mock) ??
      jest.fn().mockResolvedValue(null);

    jest.doMock("@/lib/billing/apple-subscription-reconciler", () => ({
      APPLE_RECONCILER_LOG_SOURCE: "apple-subscription-reconciler",
      reconcileAppleSubscriptions: reconcile,
    }));
    jest.doMock("@/lib/ops-events", () => ({
      reportOpsEvent,
      // logger/api-response import this from the same module — keep it real
      // enough that unrelated log calls don't explode.
      sanitizeOpsMetadata: (metadata: Record<string, unknown>) => metadata,
    }));
    jest.doMock("@/lib/supabase", () => ({
      supabaseAdmin: { from: jest.fn() },
    }));

    return { reconcile, reportOpsEvent };
  }

  it("refuses to run without CRON_SECRET configured", async () => {
    delete process.env.CRON_SECRET;
    mockDeps();

    const { GET } = await import("../route");
    const res = await GET(createRequest());
    expect(res.status).toBe(500);
  });

  it("rejects a bad bearer with 401", async () => {
    const deps = mockDeps();

    const { GET } = await import("../route");
    const res = await GET(createRequest("wrong-secret"));
    expect(res.status).toBe(401);
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  it("runs the reconciler and returns its counts", async () => {
    const deps = mockDeps({
      reconcile: jest.fn().mockResolvedValue({
        scanned: 3,
        converged: 2,
        manualReview: 0,
        skipped: 1,
        errors: 0,
        entries: [],
      }),
    });

    const { GET } = await import("../route");
    const res = await GET(createRequest());

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({
      scanned: 3,
      converged: 2,
      manualReview: 0,
      skipped: 1,
      errors: 0,
    });
    // Converged rows imply a dropped notification — ops breadcrumb fires.
    expect(deps.reportOpsEvent).toHaveBeenCalledTimes(1);
  });

  it("escalates independently when rows need manual review or fail", async () => {
    const deps = mockDeps({
      reconcile: jest.fn().mockResolvedValue({
        scanned: 2,
        converged: 0,
        manualReview: 1,
        skipped: 0,
        errors: 1,
        entries: [],
      }),
    });

    const { GET } = await import("../route");
    const res = await GET(createRequest());

    expect(res.status).toBe(200);
    expect(deps.reportOpsEvent).toHaveBeenCalledTimes(1);
    const event = deps.reportOpsEvent.mock.calls[0][0];
    expect(event.metadata.failureType).toBe("apple_reconcile_attention");
  });

  it("returns 500 when the reconciler throws", async () => {
    mockDeps({
      reconcile: jest.fn().mockRejectedValue(new Error("api down")),
    });

    const { GET } = await import("../route");
    const res = await GET(createRequest());
    expect(res.status).toBe(500);
  });
});
