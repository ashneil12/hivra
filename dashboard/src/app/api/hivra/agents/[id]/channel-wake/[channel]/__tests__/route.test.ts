/** @jest-environment node */
import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockMaybeSingle = jest.fn();
jest.mock("@clerk/nextjs/server", () => ({ auth: () => mockAuth() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: () => ({ success: true }), getIP: () => "127.0.0.1" }));
jest.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
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
jest.mock("@/lib/hivra/channel-wake/owner", () => ({
  isOwnerSwitchChannel: (c: unknown) => c === "matrix",
  readChannelWakeView: (...a: unknown[]) => mockView(...a),
  enableChannelWake: (...a: unknown[]) => mockEnable(...a),
  disableChannelWake: (...a: unknown[]) => mockDisable(...a),
}));
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: jest.fn() }));

import { GET, PATCH } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const ORIGIN = "https://app.example.test";
const params = (channel: string) => ({ params: Promise.resolve({ id: ID, channel }) });
const patch = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`${ORIGIN}/api/hivra/agents/${ID}/channel-wake/matrix`, {
    method: "PATCH",
    headers: { host: "app.example.test", origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const get = () => new NextRequest(`${ORIGIN}/api/hivra/agents/${ID}/channel-wake/matrix`);
const view = { channel: "matrix", available: true, enabled: true, armed: true };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth.mockResolvedValue({ userId: "user_1" });
  mockMaybeSingle.mockResolvedValue({ data: { id: ID, user_id: "user_1" }, error: null });
});

describe("channel wake owner route", () => {
  it("needs a session and a known channel", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await GET(get(), params("matrix"))).status).toBe(401);
    expect((await GET(get(), params("telegram"))).status).toBe(404);
    expect((await PATCH(patch({ enabled: true }), params("email"))).status).toBe(404);
  });

  it("reads the view for the owner's agent only", async () => {
    mockView.mockResolvedValue(view);
    const res = await GET(get(), params("matrix"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await GET(get(), params("matrix"))).status).toBe(404);
  });

  it("refuses a cross-site PATCH and a bad body", async () => {
    expect((await PATCH(patch({ enabled: true }, { origin: "https://evil.example.test", "sec-fetch-site": "cross-site" }), params("matrix"))).status).toBe(403);
    expect((await PATCH(patch({ enabled: "yes" }), params("matrix"))).status).toBe(400);
    expect(mockEnable).not.toHaveBeenCalled();
  });

  it("turns it on, and passes a refusal through", async () => {
    mockEnable.mockResolvedValueOnce({ ok: true, view, wake: false });
    expect((await PATCH(patch({ enabled: true }), params("matrix"))).status).toBe(200);
    expect(mockEnable).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), "matrix");
    mockEnable.mockResolvedValueOnce({ ok: false, status: 409, code: "password_login", message: "m" });
    expect((await PATCH(patch({ enabled: true }), params("matrix"))).status).toBe(409);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it("wakes an agent that slept counting on it when turned off", async () => {
    mockDisable.mockResolvedValueOnce({ ok: true, view: { ...view, enabled: false, armed: false }, wake: true });
    expect((await PATCH(patch({ enabled: false }), params("matrix"))).status).toBe(200);
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action" }));
  });
});
