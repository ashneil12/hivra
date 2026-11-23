import { NextRequest } from "next/server";

import { GET } from "../route";
import { runSurfaceWatchdogSweep } from "@/lib/recovery/hivra-surface-watchdog-sweep";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";

jest.mock("@/lib/recovery/hivra-surface-watchdog-sweep", () => ({
  runSurfaceWatchdogSweep: jest.fn(),
}));

jest.mock("@/lib/cron-heartbeat", () => ({
  recordCronHeartbeat: jest.fn(async () => undefined),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const sweepSummary = {
  scanned: 3,
  reported: 1,
  notInstalled: 0,
  unreachable: 0,
  notReached: 0,
  relayed: 1,
  failed: 0,
};

function req(authorization?: string) {
  return new NextRequest("https://example/api/cron/hivra-surface-watchdog", {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/cron/hivra-surface-watchdog", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (runSurfaceWatchdogSweep as jest.Mock).mockResolvedValue({ ...sweepSummary });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("records a clean heartbeat when the sweep finishes inside budget", async () => {
    const response = await GET(req("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(recordCronHeartbeat).toHaveBeenCalledWith("hivra-surface-watchdog", undefined);
  });

  it("records ok:false when boxes were skipped by the sweep budget", async () => {
    (runSurfaceWatchdogSweep as jest.Mock).mockResolvedValueOnce({
      ...sweepSummary,
      notReached: 4,
    });

    const response = await GET(req("Bearer cron-secret"));

    expect(response.status).toBe(200);
    expect(recordCronHeartbeat).toHaveBeenCalledWith(
      "hivra-surface-watchdog",
      expect.objectContaining({
        ok: false,
        detail: expect.stringContaining("notReached=4"),
      }),
    );
  });

  it("records ok:false when reads or relays failed", async () => {
    (runSurfaceWatchdogSweep as jest.Mock).mockResolvedValueOnce({
      ...sweepSummary,
      failed: 2,
    });

    await GET(req("Bearer cron-secret"));

    expect(recordCronHeartbeat).toHaveBeenCalledWith(
      "hivra-surface-watchdog",
      expect.objectContaining({ ok: false }),
    );
  });
});
