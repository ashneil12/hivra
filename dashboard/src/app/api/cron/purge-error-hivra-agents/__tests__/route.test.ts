import { NextRequest } from "next/server";

import { GET } from "../route";
import { runPurgeErrorHivraAgentsSweep } from "@/lib/hivra/purge-error-agents";

jest.mock("@/lib/hivra/purge-error-agents", () => ({
  runPurgeErrorHivraAgentsSweep: jest.fn(),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

describe("GET /api/cron/purge-error-hivra-agents", () => {
  const originalEnv = process.env;
  const mockedSweep = runPurgeErrorHivraAgentsSweep as jest.MockedFunction<
    typeof runPurgeErrorHivraAgentsSweep
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, CRON_SECRET: "expected-secret" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  const makeRequest = (authorization?: string, id?: string) =>
    new Request(`http://localhost/api/cron/purge-error-hivra-agents${id ? `?id=${id}` : ""}`, {
      headers: authorization ? { authorization } : {},
    }) as unknown as NextRequest;

  it("fails closed when CRON_SECRET is missing", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("rejects requests with the wrong bearer", async () => {
    const res = await GET(makeRequest("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockedSweep).not.toHaveBeenCalled();
  });

  it("returns the sweep summary on success", async () => {
    mockedSweep.mockResolvedValue({ scanned: 2, purged: 1, skipped: 1, results: [] });
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toEqual({ scanned: 2, purged: 1, skipped: 1, results: [] });
    expect(mockedSweep).toHaveBeenCalledWith({ agentId: null });
  });

  it("passes a targeted agent id to the sweep", async () => {
    mockedSweep.mockResolvedValue({ scanned: 1, purged: 1, skipped: 0, results: [] });
    const res = await GET(makeRequest("Bearer expected-secret", "00000000-0000-4000-8000-000000001038"));
    expect(res.status).toBe(200);
    expect(mockedSweep).toHaveBeenCalledWith({ agentId: "00000000-0000-4000-8000-000000001038" });
  });

  it("returns 500 when the sweep throws", async () => {
    mockedSweep.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest("Bearer expected-secret"));
    expect(res.status).toBe(500);
  });
});
