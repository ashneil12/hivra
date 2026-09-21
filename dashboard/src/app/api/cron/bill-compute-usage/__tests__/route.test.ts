import { NextRequest } from "next/server";

import { GET } from "../route";
import { billHourlyComputeUsage } from "@/lib/billing/compute-billing";

jest.mock("@/lib/billing/compute-billing", () => ({
  billHourlyComputeUsage: jest.fn(),
}));

describe("GET /api/cron/bill-compute-usage", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (billHourlyComputeUsage as jest.Mock).mockResolvedValue({
      checked: 1,
      billedInstances: 1,
      billedEvents: 1,
      skipped: 0,
      underfunded: 0,
      failed: 0,
      creditsDebited: 100,
      hourlyCredits: 100,
      results: [
        {
          status: "billed",
          instanceId: "inst_1",
          billedEvents: 1,
          creditsDebited: 100,
          billedThrough: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (
    authorization?: string,
    url = "http://localhost/api/cron/bill-compute-usage"
  ) =>
    new Request(url, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("rejects requests without the cron secret", async () => {
    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(billHourlyComputeUsage).not.toHaveBeenCalled();
  });

  it("rejects requests when the cron secret is not configured", async () => {
    process.env = { ...originalEnv, CRON_SECRET: "" };

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Cron secret is not configured");
    expect(billHourlyComputeUsage).not.toHaveBeenCalled();
  });

  it("bills compute usage with a safe limit", async () => {
    const response = await GET(makeRequest(
      "Bearer cron-secret",
      "http://localhost/api/cron/bill-compute-usage?limit=25"
    ));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(billHourlyComputeUsage).toHaveBeenCalledWith({ limit: 25 });
    expect(json.data).toEqual({
      checked: 1,
      billedInstances: 1,
      billedEvents: 1,
      skipped: 0,
      underfunded: 0,
      failed: 0,
      creditsDebited: 100,
      hourlyCredits: 100,
      results: [
        {
          status: "billed",
          instanceId: "inst_1",
          billedEvents: 1,
          creditsDebited: 100,
          billedThrough: "2026-04-24T12:00:00.000Z",
        },
      ],
    });
  });

  it("does not leak backend errors", async () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    (billHourlyComputeUsage as jest.Mock).mockRejectedValueOnce(
      new Error("billing-secret should stay private")
    );

    const response = await GET(makeRequest("Bearer cron-secret"));
    const json = await response.json();

    expect(response.status).toBe(500);
    expect(json.error).toBe("Failed to bill compute usage");
    expect(JSON.stringify(json)).not.toContain("billing-secret");
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain("billing-secret");

    consoleErrorSpy.mockRestore();
  });
});
