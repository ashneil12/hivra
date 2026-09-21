import { NextRequest } from "next/server";

import { GET } from "../route";
import { runCapacityPressureSweep } from "@/lib/recovery/capacity-pressure-sweep";

jest.mock("@/lib/recovery/capacity-pressure-sweep", () => ({
  runCapacityPressureSweep: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function buildReq(headers: Record<string, string> = {}, query = "") {
  return new NextRequest(
    `https://example/api/cron/capacity-pressure-sweep${query}`,
    { headers: new Headers(headers) }
  );
}

const baseSummary = {
  skipped: false,
  enabled: true,
  dryRun: true,
  countThreshold: 1,
  minIdleHours: 48,
  includePaid: false,
  maxPerHost: 3,
  maxTotal: 10,
  hostsScanned: 1,
  hotHosts: 0,
  parked: 0,
  failed: 0,
  vmMissing: 0,
  emailsSent: 0,
  hosts: [],
};

describe("GET /api/cron/capacity-pressure-sweep", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (runCapacityPressureSweep as jest.Mock).mockResolvedValue(baseSummary);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rejects missing bearer auth with 401", async () => {
    const res = await GET(buildReq());
    expect(res.status).toBe(401);
    expect(runCapacityPressureSweep).not.toHaveBeenCalled();
  });

  it("rejects when CRON_SECRET is unset with 500", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(buildReq({ authorization: "Bearer anything" }));
    expect(res.status).toBe(500);
    expect(runCapacityPressureSweep).not.toHaveBeenCalled();
  });

  it("returns the sweep summary on success", async () => {
    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toEqual(baseSummary);
    // No ?dryRun param — the env-driven default decides inside the lib.
    expect(runCapacityPressureSweep).toHaveBeenCalledWith({});
  });

  it("forces a dry run when ?dryRun=1 is passed", async () => {
    const res = await GET(
      buildReq({ authorization: "Bearer cron-secret" }, "?dryRun=1")
    );

    expect(res.status).toBe(200);
    expect(runCapacityPressureSweep).toHaveBeenCalledWith({ dryRun: true });
  });

  it("surfaces the disabled-gate summary as {skipped:true}", async () => {
    (runCapacityPressureSweep as jest.Mock).mockResolvedValue({
      ...baseSummary,
      skipped: true,
      enabled: false,
    });

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.skipped).toBe(true);
  });

  it("returns 500 when the sweep itself throws", async () => {
    (runCapacityPressureSweep as jest.Mock).mockRejectedValue(
      new Error("Database not configured")
    );

    const res = await GET(buildReq({ authorization: "Bearer cron-secret" }));

    expect(res.status).toBe(500);
  });
});
