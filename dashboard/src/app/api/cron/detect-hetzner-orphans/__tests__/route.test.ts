import { NextRequest } from "next/server";

import { GET } from "../route";
import { runHetznerOrphanSweep } from "@/lib/recovery/hetzner-orphan-detection";
import { reportOpsEvent } from "@/lib/ops-events";

jest.mock("@/lib/recovery/hetzner-orphan-detection", () => ({
  runHetznerOrphanSweep: jest.fn(),
}));

jest.mock("@/lib/ops-events", () => ({
  ...jest.requireActual("@/lib/ops-events"),
  reportOpsEvent: jest.fn().mockResolvedValue(undefined),
}));

const ORIGINAL_ENV = process.env;

function makeRequest(authorization?: string): NextRequest {
  return new Request("http://localhost/api/cron/detect-hetzner-orphans", {
    headers: authorization ? { authorization } : {},
  }) as unknown as NextRequest;
}

const EMPTY_SUMMARY = {
  skipped: null,
  serversScanned: 0,
  liveServers: 0,
  youngServers: 0,
  orphans: [],
};

describe("GET /api/cron/detect-hetzner-orphans", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...ORIGINAL_ENV, CRON_SECRET: "cron-secret" };
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  it("refuses requests without the cron bearer secret", async () => {
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(runHetznerOrphanSweep).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("Bearer anything"));
    expect(res.status).toBe(500);
    expect(runHetznerOrphanSweep).not.toHaveBeenCalled();
  });

  it("reports nothing to ops when no orphan servers are found", async () => {
    (runHetznerOrphanSweep as jest.Mock).mockResolvedValue(EMPTY_SUMMARY);

    const res = await GET(makeRequest("Bearer cron-secret"));

    expect(res.status).toBe(200);
    expect(reportOpsEvent).not.toHaveBeenCalled();
  });

  it("escalates detected orphan servers to the ops feed without deleting anything", async () => {
    (runHetznerOrphanSweep as jest.Mock).mockResolvedValue({
      ...EMPTY_SUMMARY,
      serversScanned: 1,
      orphans: [
        {
          serverId: 9001,
          name: "host-abc",
          createdAt: "2026-10-29T08:00:00Z",
          ageHours: 4,
          reason: "no_live_row",
          instanceId: null,
        },
      ],
    });

    const res = await GET(makeRequest("Bearer cron-secret"));

    expect(res.status).toBe(200);
    expect(reportOpsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "warn", route: "/api/cron/detect-hetzner-orphans" })
    );
  });
});
