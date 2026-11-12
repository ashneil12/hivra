import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEnsure = jest.fn();
const mockAfter = jest.fn();
const mockEq = jest.fn();

jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (...a: unknown[]) => mockAfter(...a) }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  getIP: () => "127.0.0.1",
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (...args: unknown[]) => { mockEq(...args); return q; };
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));
jest.mock("@/lib/hivra/agent-wake", () => ({ ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a) }));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { POST } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const params = { params: Promise.resolve({ id: ID }) };

function request(headers: Record<string, string> = {}) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/wake`, {
    method: "POST",
    headers: {
      host: "canary.hermesos.cloud",
      origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      ...headers,
    },
    body: "{}",
  });
}

describe("POST /api/hivra/agents/[id]/wake", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hermesos.cloud";
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockRateLimit.mockReturnValue({ success: true });
    mockMaybeSingle.mockResolvedValue({ data: { id: ID }, error: null });
    mockEnsure.mockResolvedValue({ state: "awake", wakeMs: 1400 });
  });

  it("requires sign-in, same origin and the owner", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await POST(request(), params)).status).toBe(401);
    expect((await POST(request({ origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await POST(request(), params)).status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("is rate limited", async () => {
    mockRateLimit.mockReturnValue({ success: false, retryAfterMs: 1000 });
    expect((await POST(request(), params)).status).toBe(429);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("wakes with a 45 second wait and answers 200 with the wake time", async () => {
    const response = await POST(request(), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ state: "awake", wakeMs: 1400 });
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "open", waitMs: 45_000 }));
  });

  it("hands unfinished wake work to after()", async () => {
    mockEnsure.mockImplementation(async (_id: string, options: { onBackground: (work: Promise<unknown>) => void }) => {
      options.onBackground(Promise.resolve());
      return { state: "waking", reason: "in_progress" };
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(202);
    expect((await response.json()).data).toEqual({ state: "waking" });
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("answers 402 for a lapsed owner and 503 for a failed wake", async () => {
    mockEnsure.mockResolvedValueOnce({ state: "failed", reason: "lapsed" });
    const lapsed = await POST(request(), params);
    expect(lapsed.status).toBe(402);
    mockEnsure.mockResolvedValueOnce({ state: "failed", reason: "no_receipt" });
    const failed = await POST(request(), params);
    expect(failed.status).toBe(503);
    expect((await failed.json()).state).toBe("failed");
  });

  it("never reports a switched off computer as awake: it answers 409 not_running", async () => {
    mockEnsure.mockResolvedValueOnce({ state: "cold", reason: "cold" });
    const response = await POST(request(), params);
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body).toMatchObject({ success: false, code: "not_running", state: "cold" });
    expect(body.error).toMatch(/switched off/i);
  });

  it("looks the agent up by id and signed-in owner before it wakes anything", async () => {
    expect((await POST(request(), params)).status).toBe(200);
    expect(mockEq).toHaveBeenCalledWith("id", ID);
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    mockEnsure.mockClear();
    expect((await POST(request(), params)).status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });
});
