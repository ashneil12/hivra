import { NextRequest } from "next/server";

import { GET } from "../route";
import { recordCronHeartbeat } from "@/lib/cron-heartbeat";
import { runObserveAgentSleepSweep } from "@/lib/hivra/observe-agent-sleep";

jest.mock("@/lib/hivra/observe-agent-sleep", () => ({ runObserveAgentSleepSweep: jest.fn() }));
jest.mock("@/lib/cron-heartbeat", () => ({ recordCronHeartbeat: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const summary = (over: Record<string, unknown> = {}) => ({
  mode: "observe",
  skipped: false,
  scanned: 1,
  inserted: 1,
  pruned: 0,
  truncated: false,
  verdicts: { awake: 1, would_nap: 0, would_hibernate: 0, ineligible: 0 },
  errors: 0,
  ...over,
});

function req(authorization?: string) {
  return new NextRequest("https://example/api/cron/observe-agent-sleep", {
    headers: authorization ? { authorization } : {},
  });
}

describe("GET /api/cron/observe-agent-sleep", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "cron-secret" };
    (runObserveAgentSleepSweep as jest.Mock).mockResolvedValue(summary());
  });
  afterEach(() => {
    process.env = originalEnv;
  });

  it("refuses to run when the cron secret is not configured", async () => {
    delete process.env.CRON_SECRET;
    const response = await GET(req("Bearer anything"));
    expect(response.status).toBe(500);
    expect(runObserveAgentSleepSweep).not.toHaveBeenCalled();
  });

  it.each([undefined, "Bearer wrong", "cron-secret", "Basic cron-secret"])("rejects authorization %p", async (header) => {
    const response = await GET(req(header));
    expect(response.status).toBe(401);
    expect(runObserveAgentSleepSweep).not.toHaveBeenCalled();
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
  });

  it("runs the sweep, returns its summary and stamps the heartbeat", async () => {
    const response = await GET(req("Bearer cron-secret"));
    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({ mode: "observe", inserted: 1 });
    expect(recordCronHeartbeat).toHaveBeenCalledWith("observe-agent-sleep");
  });

  it("touches nothing, heartbeat included, when the sweep is skipped", async () => {
    (runObserveAgentSleepSweep as jest.Mock).mockResolvedValue(summary({ mode: "off", skipped: true, reason: "sleep_mode_off" }));
    const response = await GET(req("Bearer cron-secret"));
    expect(response.status).toBe(200);
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
  });

  it("does not stamp the heartbeat when the run had errors", async () => {
    (runObserveAgentSleepSweep as jest.Mock).mockResolvedValue(summary({ errors: 1 }));
    await GET(req("Bearer cron-secret"));
    expect(recordCronHeartbeat).not.toHaveBeenCalled();
  });

  it("returns 500 when the sweep throws", async () => {
    (runObserveAgentSleepSweep as jest.Mock).mockRejectedValue(new Error("boom"));
    const response = await GET(req("Bearer cron-secret"));
    expect(response.status).toBe(500);
  });
});
