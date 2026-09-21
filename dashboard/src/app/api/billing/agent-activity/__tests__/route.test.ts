import { NextRequest } from "next/server";
import { auth } from "@clerk/nextjs/server";

import { GET } from "../route";
import { getUserAgentActivity } from "@/lib/billing/agent-activity";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/billing/agent-activity", () => ({
  getUserAgentActivity: jest.fn(),
}));

/**
 * The route had no test at all while every sibling billing route had one — which
 * is how the Hivra-lane scope gap survived. These cover the contract the panel
 * depends on: auth gate, day clamping, the no-store header, and error hygiene.
 */
describe("GET /api/billing/agent-activity", () => {
  const userId = "user_123";

  const EMPTY = {
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      estimatedCostUsd: 0,
      sessions: 0,
      apiCalls: 0,
      toolCalls: 0,
    },
    daily: [],
    topModels: [],
    topSkills: [],
    instanceCount: 0,
    activeDays: 0,
    hivra: {
      eventCount: 0,
      byEvent: [],
      byAgentType: [],
      activeDays: 0,
      desktopSessions: 0,
      desktopDays: 0,
      daily: [],
      fleet: { runningAgents: 0, totalAgents: 0, firstAgentAt: null, byStatus: {} },
      recent: [],
      truncated: false,
    },
    coverage: "none" as const,
    generatedAt: "2026-06-13T12:00:00.000Z",
  };

  function makeRequest(url = "http://localhost/api/billing/agent-activity") {
    return new Request(url) as unknown as NextRequest;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId });
    (getUserAgentActivity as jest.Mock).mockResolvedValue(EMPTY);
  });

  it("rejects unauthenticated users without touching the data layer", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });

    const response = await GET(makeRequest());

    expect(response.status).toBe(401);
    expect(getUserAgentActivity).not.toHaveBeenCalled();
  });

  it("returns the caller's own activity and never caches it", async () => {
    const response = await GET(makeRequest("http://localhost/api/billing/agent-activity?days=30"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(getUserAgentActivity).toHaveBeenCalledWith(userId, { days: 30 });
  });

  it("passes a missing days param through as undefined (the 30-day default)", async () => {
    await GET(makeRequest());

    expect(getUserAgentActivity).toHaveBeenCalledWith(userId, { days: undefined });
  });

  it("passes a non-numeric days param through as undefined rather than NaN", async () => {
    await GET(makeRequest("http://localhost/api/billing/agent-activity?days=abc"));

    expect(getUserAgentActivity).toHaveBeenCalledWith(userId, { days: undefined });
  });

  it("surfaces the coverage discriminator the panel branches on", async () => {
    (getUserAgentActivity as jest.Mock).mockResolvedValueOnce({
      ...EMPTY,
      coverage: "activity",
      hivra: { ...EMPTY.hivra, eventCount: 309, desktopSessions: 231 },
    });

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(body.data.coverage).toBe("activity");
    expect(body.data.hivra.eventCount).toBe(309);
  });

  it("does not leak backend errors to the client", async () => {
    (getUserAgentActivity as jest.Mock).mockRejectedValueOnce(
      new Error("agent-activity-secret")
    );

    const response = await GET(makeRequest());
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.error).toBe("Failed to fetch agent activity");
    expect(JSON.stringify(body)).not.toContain("agent-activity-secret");
  });
});
