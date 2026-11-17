import { NextRequest } from "next/server";

import { GET } from "../route";
import { runHostCapacitySweep } from "@/lib/hivra/capacity/sweep";

jest.mock("@/lib/hivra/capacity/sweep", () => ({ runHostCapacitySweep: jest.fn() }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

function req(authorization?: string) {
  return new NextRequest("https://example/api/cron/hivra-host-capacity", {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/cron/hivra-host-capacity", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (runHostCapacitySweep as jest.Mock).mockResolvedValue({ skipped: false, hosts: 2, read: 2 });
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("refuses to run when the cron secret is not configured", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(req("Bearer anything"))).status).toBe(500);
    expect(runHostCapacitySweep).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", "cron-secret", "Basic cron-secret"])("rejects authorization %p", async (header) => {
    expect((await GET(req(header))).status).toBe(401);
    expect(runHostCapacitySweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its summary", async () => {
    const response = await GET(req("Bearer cron-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ hosts: 2, read: 2 });
  });

  it("answers 500 when the sweep could not load its hosts or agents", async () => {
    (runHostCapacitySweep as jest.Mock).mockResolvedValue({ skipped: false, failed: true, reason: "hosts_query_failed", errors: 1 });
    expect((await GET(req("Bearer cron-secret"))).status).toBe(500);
  });

  it("answers 500 when the sweep throws", async () => {
    (runHostCapacitySweep as jest.Mock).mockRejectedValue(new Error("boom"));
    expect((await GET(req("Bearer cron-secret"))).status).toBe(500);
  });

  it("is registered to run every 5 minutes", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { crons } = require("../../../../../../vercel.json") as { crons: Array<{ path: string; schedule: string }> };
    expect(crons.filter((cron) => cron.path === "/api/cron/hivra-host-capacity")).toEqual([
      { path: "/api/cron/hivra-host-capacity", schedule: "*/5 * * * *" },
    ]);
  });
});
