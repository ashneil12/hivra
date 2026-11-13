import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockMaybeSingle = jest.fn();
const mockEq = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  getIP: () => "127.0.0.1",
}));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (...a: unknown[]) => { mockEq(...a); return q; };
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockEnsure = jest.fn();
jest.mock("@/lib/hivra/agent-wake", () => ({ ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a) }));
const mockView = jest.fn();
const mockEnable = jest.fn();
const mockDisable = jest.fn();
jest.mock("@/lib/hivra/telegram-wake/owner", () => ({
  readTelegramWakeView: (...a: unknown[]) => mockView(...a),
  enableTelegramWake: (...a: unknown[]) => mockEnable(...a),
  disableTelegramWake: (...a: unknown[]) => mockDisable(...a),
}));
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }));

import { GET, PATCH } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const params = { params: Promise.resolve({ id: ID }) };
const ORIGIN = "https://app.example.test";

function patch(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/hivra/agents/${ID}/telegram-wake`, {
    method: "PATCH",
    headers: { host: "app.example.test", origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}
const get = () => new NextRequest(`${ORIGIN}/api/hivra/agents/${ID}/telegram-wake`);
const view = { available: true, enabled: true, armed: false };

describe("/api/hivra/agents/[id]/telegram-wake", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = ORIGIN;
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockRateLimit.mockReturnValue({ success: true });
    mockMaybeSingle.mockResolvedValue({ data: { id: ID, user_id: "user-1" }, error: null });
    mockView.mockResolvedValue(view);
    mockEnable.mockResolvedValue({ ok: true, view, wake: false });
    mockDisable.mockResolvedValue({ ok: true, view: { ...view, enabled: false }, wake: true });
    mockEnsure.mockResolvedValue({ state: "waking" });
  });

  it("GET needs sign-in and the owner's agent", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await GET(get(), params)).status).toBe(401);
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await GET(get(), params)).status).toBe(404);
    const response = await GET(get(), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(view);
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("PATCH requires sign-in, same origin and a rate limit, like the other agent settings", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await PATCH(patch({ enabled: true }), params)).status).toBe(401);
    expect((await PATCH(patch({ enabled: true }, { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    mockRateLimit.mockReturnValue({ success: false, retryAfterMs: 1000 });
    expect((await PATCH(patch({ enabled: true }), params)).status).toBe(429);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it("PATCH checks the body and the owner", async () => {
    expect((await PATCH(patch({ enabled: "yes" }), params)).status).toBe(400);
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await PATCH(patch({ enabled: true }), params)).status).toBe(404);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it("turns it on, and passes a refusal through with its code", async () => {
    const response = await PATCH(patch({ enabled: true }), params);
    expect(response.status).toBe(200);
    expect(mockEnable).toHaveBeenCalledWith({ id: ID, user_id: "user-1" }, "user-1");
    expect(mockEnsure).not.toHaveBeenCalled();
    mockEnable.mockResolvedValueOnce({ ok: false, status: 409, code: "not_awake", message: "Your agent needs to be awake." });
    const refused = await PATCH(patch({ enabled: true }), params);
    expect(refused.status).toBe(409);
  });

  it("turning it off wakes an agent that was waiting on Telegram", async () => {
    const response = await PATCH(patch({ enabled: false }), params);
    expect(response.status).toBe(200);
    expect(mockDisable).toHaveBeenCalled();
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action", waitMs: 0 }));
  });
});
