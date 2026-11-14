/** @jest-environment node */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GET, maxDuration } from "../route";

const mockSampling = jest.fn();
jest.mock("@/lib/hivra/agent-activity-sampler", () => ({
  ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS: jest.requireActual("@/lib/hivra/agent-activity-sampler").ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS,
  runAgentActivitySampling: (...args: unknown[]) => mockSampling(...args),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: null }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const summary = { enabled: true, scanned: 3, sampled: 2, active: 1, unreachable: 1, notReached: 0, failed: 0 };
const request = (authorization?: string) => new NextRequest("https://hivra.cloud/api/cron/sample-agent-activity", {
  headers: authorization ? { Authorization: authorization } : {},
});

describe("GET /api/cron/sample-agent-activity", () => {
  const prior = process.env.CRON_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret-fixture";
    mockSampling.mockResolvedValue(summary);
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  });

  it("is given the time the sampler's read budget is set under, and is on the schedule", () => {
    const { ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS } = jest.requireMock("@/lib/hivra/agent-activity-sampler") as { ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS: number };
    expect(maxDuration * 1000).toBe(ACTIVITY_SAMPLING_FUNCTION_LIMIT_MS);
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons).toContainEqual({ path: "/api/cron/sample-agent-activity", schedule: "*/10 * * * *" });
  });

  it("refuses to run without a configured secret", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer anything"))).status).toBe(500);
    expect(mockSampling).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing secret", async () => {
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect((await GET(request())).status).toBe(401);
    expect(mockSampling).not.toHaveBeenCalled();
  });

  it("runs the sampler and returns its summary", async () => {
    const response = await GET(request("Bearer cron-secret-fixture"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: summary });
  });

  it("answers 500 when the sampler throws", async () => {
    mockSampling.mockRejectedValue(new Error("boom"));
    expect((await GET(request("Bearer cron-secret-fixture"))).status).toBe(500);
  });
});
