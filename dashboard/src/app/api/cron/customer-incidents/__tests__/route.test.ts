import { NextRequest } from "next/server";

const mockScan = jest.fn();
const mockHeartbeat = jest.fn();

jest.mock("@/lib/recovery/customer-incidents", () => ({
  runCustomerIncidentScan: (...args: unknown[]) => mockScan(...args),
}));
jest.mock("@/lib/cron-heartbeat", () => ({
  recordCronHeartbeat: (...args: unknown[]) => mockHeartbeat(...args),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { GET } from "../route";

const ORIGINAL_ENV = process.env;

function request(token = "expected-secret") {
  return new NextRequest("http://localhost/api/cron/customer-incidents", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("GET /api/cron/customer-incidents", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "expected-secret" };
    mockScan.mockResolvedValue({ findings: 0, opened: 0, stillOpen: 0, resolved: 0, unknown: 0, failed: 0 });
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it("refuses to run without CRON_SECRET configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("rejects a caller without the right bearer token", async () => {
    const response = await GET(request("wrong"));
    expect(response.status).toBe(401);
    expect(mockScan).not.toHaveBeenCalled();
  });

  it("runs the scan and records a clean heartbeat when nothing failed", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mockScan).toHaveBeenCalledTimes(1);
    expect(mockHeartbeat).toHaveBeenCalledWith("customer-incidents", undefined);
  });

  it("records ok:false when the scan reports failures", async () => {
    mockScan.mockResolvedValue({ findings: 2, opened: 1, stillOpen: 0, resolved: 0, unknown: 0, failed: 1 });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mockHeartbeat).toHaveBeenCalledWith("customer-incidents", {
      ok: false,
      detail: "failed=1",
    });
  });

  it("records an ok:false heartbeat and still returns 500 when the scan throws", async () => {
    mockScan.mockRejectedValue(new Error("collection exploded"));
    const response = await GET(request());
    expect(response.status).toBe(500);
    expect(mockHeartbeat).toHaveBeenCalledWith("customer-incidents", {
      ok: false,
      detail: "scan threw",
    });
  });
});
