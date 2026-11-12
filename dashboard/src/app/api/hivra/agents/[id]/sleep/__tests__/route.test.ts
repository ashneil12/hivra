import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockMaybeSingle = jest.fn();
const mockSleep = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  getIP: () => "127.0.0.1",
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq"]) q[m] = () => q;
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));
jest.mock("@/lib/hivra/agent-sleep", () => ({ sleepHivraAgent: (...a: unknown[]) => mockSleep(...a) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { POST } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const params = { params: Promise.resolve({ id: ID }) };

function request(body: unknown = { tier: "nap" }, headers: Record<string, string> = {}) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/sleep`, {
    method: "POST",
    headers: {
      host: "canary.hermesos.cloud",
      origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/hivra/agents/[id]/sleep", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hermesos.cloud";
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    process.env.HIVRA_SLEEP_MODE = "canary";
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockRateLimit.mockReturnValue({ success: true });
    mockMaybeSingle.mockResolvedValue({ data: { id: ID }, error: null });
    mockSleep.mockResolvedValue({ outcome: "slept", state: "napping" });
  });
  afterAll(() => { process.env = saved; });

  it("is unavailable unless the screens are on and the server mode is not off", async () => {
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "0";
    expect((await POST(request(), params)).status).toBe(404);
    process.env.NEXT_PUBLIC_HIVRA_AGENT_SLEEP = "1";
    process.env.HIVRA_SLEEP_MODE = "off";
    expect((await POST(request(), params)).status).toBe(404);
    delete process.env.HIVRA_SLEEP_MODE;
    expect((await POST(request(), params)).status).toBe(404);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("requires sign-in, same origin, a valid tier and the owner", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await POST(request(), params)).status).toBe(401);
    expect((await POST(request(), params)).status).toBe(200);
    expect((await POST(request({ tier: "nap" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    expect((await POST(request({ tier: "deep" }), params)).status).toBe(400);
    expect((await POST(request({}), params)).status).toBe(400);
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await POST(request(), params)).status).toBe(404);
  });

  it("is rate limited", async () => {
    mockRateLimit.mockReturnValue({ success: false, retryAfterMs: 1000 });
    expect((await POST(request(), params)).status).toBe(429);
    expect(mockSleep).not.toHaveBeenCalled();
  });

  it("runs a manual sleep for the owner's agent and reports the outcome", async () => {
    const response = await POST(request({ tier: "hibernate" }), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ outcome: "slept", state: "napping" });
    expect(mockSleep).toHaveBeenCalledWith(ID, { tier: "hibernate", trigger: "manual", manual: true });
  });

  it("reports a refusal with its reasons, and a failure as 502", async () => {
    mockSleep.mockResolvedValueOnce({ outcome: "ineligible", reason: "always_on", reasons: ["always_on"] });
    const refused = await POST(request(), params);
    expect(refused.status).toBe(200);
    expect((await refused.json()).data).toEqual({ outcome: "ineligible", reason: "always_on", reasons: ["always_on"] });
    mockSleep.mockResolvedValueOnce({ outcome: "failed", reason: "no_receipt", state: "awake" });
    expect((await POST(request(), params)).status).toBe(502);
  });
});
