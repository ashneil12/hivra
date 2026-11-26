import { NextRequest } from "next/server";

import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runInstanceHealthSweep } from "@/lib/recovery/instance-health-sweep";
import { GET } from "../route";

jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn() }));
jest.mock("@/lib/recovery/instance-health-sweep", () => ({ runInstanceHealthSweep: jest.fn() }));
jest.mock("@/lib/logger", () => ({ log: { error: jest.fn(), warn: jest.fn() } }));

const summary = {
  probed: 3, failed: 0, recoveredViaFallback: 0, suppressedPendingFailures: 0,
  skippedPaused: 0, archivedHealthy: 0, archivedActionFailures: 0, backendLaneViolations: 0,
  results: [],
};

const cronRequest = new NextRequest("https://dashboard.example/api/cron/probe-instance-health", {
  headers: { authorization: "Bearer test-cron-secret" },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.replaceProperty(process, "env", { ...process.env, CRON_SECRET: "test-cron-secret" });
});

afterEach(() => jest.restoreAllMocks());

it("reuses the existing successful heartbeat without exposing timing in the response", async () => {
  const hostTiming = {
    version: 1 as const,
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:00:01.000Z",
    upperBoundsMs: [100, 250, 500, 1_000, 2_000, 5_000, 12_000] as const,
    hosts: [{ host: "pve-test", probes: 3, failures: 1, reachableBuckets: [1, 0, 1, 0, 0, 0, 0, 0] }],
  };
  jest.mocked(runInstanceHealthSweep).mockResolvedValue({ ...summary, hostTiming });
  const res = await GET(cronRequest);
  expect(await res.json()).toEqual({ success: true, data: summary });
  expect(recordCronHeartbeat).toHaveBeenCalledTimes(1);
  expect(recordCronHeartbeat).toHaveBeenCalledWith("probe-instance-health", {
    detail: JSON.stringify(hostTiming),
  });
});

it("keeps the original heartbeat behavior without a timing snapshot", async () => {
  jest.mocked(runInstanceHealthSweep).mockResolvedValue(summary);
  const res = await GET(cronRequest);
  expect(res.status).toBe(200);
  expect(recordCronHeartbeat).toHaveBeenCalledTimes(1);
  expect(recordCronHeartbeat).toHaveBeenCalledWith("probe-instance-health", undefined);
});

it("does not collect or persist timings without cron authorization", async () => {
  const res = await GET(new NextRequest("https://dashboard.example/api/cron/probe-instance-health"));
  expect(res.status).toBe(401);
  expect(runInstanceHealthSweep).not.toHaveBeenCalled();
  expect(recordCronHeartbeat).not.toHaveBeenCalled();
});
