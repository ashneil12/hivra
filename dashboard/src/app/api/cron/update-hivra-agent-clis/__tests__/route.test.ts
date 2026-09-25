/** @jest-environment node */
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GET } from "../route";

const mockSweep = jest.fn();
const mockOpsEvent = jest.fn();
jest.mock("@/lib/hivra/agent-cli-auto-update", () => ({ runAgentCliAutoUpdateSweep: (...args: unknown[]) => mockSweep(...args) }));
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: (...args: unknown[]) => mockOpsEvent(...args) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const summary = (extra: Record<string, unknown> = {}) => ({
  mode: "on", dryRun: false, scanned: 3, observed: 3, updated: 0, wouldUpdate: 0, failed: 0, skipped: {}, results: [], ...extra,
});
const request = (authorization?: string, query = "") => new NextRequest(`https://hivra.cloud/api/cron/update-hivra-agent-clis${query}`, {
  headers: authorization ? { Authorization: authorization } : {},
});

describe("GET /api/cron/update-hivra-agent-clis", () => {
  const prior = process.env.CRON_SECRET;
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CRON_SECRET = "cron-secret-fixture";
    mockSweep.mockResolvedValue(summary());
  });
  afterAll(() => {
    if (prior === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prior;
  });

  it("refuses to run without a configured secret", async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(request("Bearer anything"))).status).toBe(500);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing secret", async () => {
    expect((await GET(request("Bearer wrong"))).status).toBe(401);
    expect((await GET(request())).status).toBe(401);
    expect(mockSweep).not.toHaveBeenCalled();
  });

  it("runs the sweep and returns its summary", async () => {
    const response = await GET(request("Bearer cron-secret-fixture"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: summary() });
    expect(mockSweep).toHaveBeenCalledWith({ dryRun: false });
    expect(mockOpsEvent).not.toHaveBeenCalled();
  });

  it("forces a report with ?dryRun=1", async () => {
    await GET(request("Bearer cron-secret-fixture", "?dryRun=1"));
    expect(mockSweep).toHaveBeenCalledWith({ dryRun: true });
  });

  it("tells operations when it updated or couldn't update agents", async () => {
    mockSweep.mockResolvedValue(summary({ updated: 2, failed: 1 }));
    await GET(request("Bearer cron-secret-fixture"));
    expect(mockOpsEvent).toHaveBeenCalledWith(expect.objectContaining({ source: "cron.update_hivra_agent_clis", severity: "warn" }));
  });

  it("is scheduled every 30 minutes", () => {
    const vercel = JSON.parse(readFileSync(path.join(process.cwd(), "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> };
    expect(vercel.crons).toContainEqual({ path: "/api/cron/update-hivra-agent-clis", schedule: "*/30 * * * *" });
  });
});
