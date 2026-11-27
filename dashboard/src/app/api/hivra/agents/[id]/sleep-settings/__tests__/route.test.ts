import { NextRequest } from "next/server";

const mockAuth = jest.fn();
const mockRateLimit = jest.fn();
const mockMaybeSingle = jest.fn();
const queueAgentRow = (row: Record<string, unknown>) => {
  mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, seat_funding: null }, error: null });
  mockMaybeSingle.mockResolvedValueOnce({ data: row, error: null });
};
const mockUpdate = jest.fn();
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
      q.update = (patch: unknown) => { mockUpdate(patch); return q; };
      q.eq = (...a: unknown[]) => { mockEq(...a); return q; };
      q.select = () => q;
      q.maybeSingle = () => mockMaybeSingle();
      return q;
    },
  },
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
const mockEnsure = jest.fn();
jest.mock("@/lib/hivra/agent-wake", () => ({ ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a) }));
const mockInCardTrial = jest.fn();
jest.mock("@/lib/billing/card-trial", () => ({
  ...jest.requireActual("@/lib/billing/card-trial"),
  isInCardTrial: (...a: unknown[]) => mockInCardTrial(...a),
}));
const mockAfter = jest.fn();
jest.mock("next/server", () => ({ ...jest.requireActual("next/server"), after: (...a: unknown[]) => mockAfter(...a) }));

import { PATCH } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const params = { params: Promise.resolve({ id: ID }) };

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/sleep-settings`, {
    method: "PATCH",
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

describe("PATCH /api/hivra/agents/[id]/sleep-settings", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NEXT_PUBLIC_APP_URL = "https://canary.hermesos.cloud";
    mockAuth.mockResolvedValue({ userId: "user-1" });
    mockRateLimit.mockReturnValue({ success: true });
    mockMaybeSingle.mockReset();
    queueAgentRow({ id: ID, always_on: true, sleep_policy: "full", seat_funding: null });
    mockEnsure.mockResolvedValue({ state: "awake" });
    mockInCardTrial.mockResolvedValue(false);
  });

  it.each([{ always_on: true }, { sleep_policy: "off" }])("refuses %j during a card trial", async (body) => {
    mockInCardTrial.mockResolvedValueOnce(true);
    const res = await PATCH(request(body), params);
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("requires sign-in and same origin, and is rate limited", async () => {
    mockAuth.mockResolvedValueOnce({ userId: null });
    expect((await PATCH(request({ always_on: true }), params)).status).toBe(401);
    expect((await PATCH(request({ always_on: true }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" }), params)).status).toBe(403);
    mockRateLimit.mockReturnValue({ success: false, retryAfterMs: 1000 });
    expect((await PATCH(request({ always_on: true }), params)).status).toBe(429);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("saves Keep awake and Sleep when idle for the owner's agent only", async () => {
    const response = await PATCH(request({ always_on: true, sleep_policy: "full" }), params);
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ always_on: true, sleep_policy: "full", seat_funding: null });
    expect(mockUpdate).toHaveBeenCalledWith({ always_on: true, sleep_policy: "full" });
    expect(mockEq).toHaveBeenCalledWith("id", ID);
    expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it("saves one setting alone", async () => {
    await PATCH(request({ sleep_policy: "off" }), params);
    expect(mockUpdate).toHaveBeenCalledWith({ sleep_policy: "off" });
  });

  it("refuses anything but plain on and off values, and extra fields are ignored", async () => {
    for (const body of [{}, { always_on: "yes" }, { sleep_policy: "t1" }, { sleep_policy: "hibernate" }, null, [], { status: "error" }]) {
      expect((await PATCH(request(body), params)).status).toBe(400);
    }
    await PATCH(request({ always_on: false, status: "error", sleep_state: "napping" }), params);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ always_on: false });
  });

  it("answers 404 when the agent is not the caller's", async () => {
    mockMaybeSingle.mockReset();
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await PATCH(request({ always_on: true }), params)).status).toBe(404);
  });

  it("wakes an agent that is asleep when Keep awake is switched on or Sleep when idle is switched off", async () => {
    await PATCH(request({ always_on: true }), params);
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action", waitMs: 0 }));
    mockEnsure.mockClear();
    queueAgentRow({ id: ID, always_on: false, sleep_policy: "off", seat_funding: null });
    await PATCH(request({ sleep_policy: "off" }), params);
    expect(mockEnsure).toHaveBeenCalledTimes(1);
    // Wake work that is still going is kept alive after the answer.
    const call = mockEnsure.mock.calls[0][1] as { onBackground: (work: Promise<unknown>) => void };
    const work = Promise.resolve();
    call.onBackground(work);
    expect(mockAfter).toHaveBeenCalledTimes(1);
  });

  it("does not wake anything when the agent is left free to sleep, and still saves when the wake throws", async () => {
    mockMaybeSingle.mockReset();
    queueAgentRow({ id: ID, always_on: false, sleep_policy: "full", seat_funding: null });
    expect((await PATCH(request({ always_on: false }), params)).status).toBe(200);
    expect(mockEnsure).not.toHaveBeenCalled();
    mockMaybeSingle.mockReset();
    queueAgentRow({ id: ID, always_on: true, sleep_policy: "full", seat_funding: null });
    mockEnsure.mockRejectedValue(new Error("boom"));
    expect((await PATCH(request({ always_on: true }), params)).status).toBe(200);
  });

  it("wakes for either opt-out in global on mode", async () => {
    const before = process.env.HIVRA_SLEEP_MODE;
    process.env.HIVRA_SLEEP_MODE = "on";
    try {
      mockMaybeSingle.mockReset();
      queueAgentRow({ id: ID, always_on: false, sleep_policy: "off", seat_funding: null });
      expect((await PATCH(request({ sleep_policy: "off" }), params)).status).toBe(200);
      expect(mockEnsure).toHaveBeenCalledTimes(1);
      queueAgentRow({ id: ID, always_on: true, sleep_policy: "off", seat_funding: null });
      await PATCH(request({ always_on: true }), params);
      expect(mockEnsure).toHaveBeenCalledTimes(2);
    } finally {
      if (before === undefined) delete process.env.HIVRA_SLEEP_MODE;
      else process.env.HIVRA_SLEEP_MODE = before;
    }
  });

  it.each([{ always_on: true }, { sleep_policy: "off" }, { always_on: true, sleep_policy: "off" }])(
    "rejects holder seat override %j before billing checks, writes, or wake side effects",
    async (body) => {
      mockMaybeSingle.mockReset();
      mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, seat_funding: "holder" }, error: null });
      const res = await PATCH(request(body), params);
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/funded by holding tokens/);
      expect(mockInCardTrial).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockEnsure).not.toHaveBeenCalled();
    },
  );



  it("keeps always-on control on an explicitly paid seat, with no user-level token inference", async () => {
    mockMaybeSingle.mockReset();
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, seat_funding: "paid" }, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, always_on: true, sleep_policy: "off", seat_funding: "paid" }, error: null });
    const res = await PATCH(request({ always_on: true }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ always_on: true, sleep_policy: "off", seat_funding: "paid" });
    expect(mockUpdate).toHaveBeenCalledWith({ always_on: true });
  });

  it("normalizes and reports effective controls for a holder confirmation without changing paid behavior", async () => {
    mockMaybeSingle.mockReset();
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, seat_funding: "holder" }, error: null });
    mockMaybeSingle.mockResolvedValueOnce({ data: { id: ID, always_on: false, sleep_policy: "full", seat_funding: "holder" }, error: null });
    const res = await PATCH(request({ always_on: false }), params);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ always_on: false, sleep_policy: "full", seat_funding: "holder" });
    expect(mockUpdate).toHaveBeenCalledWith({ always_on: false, sleep_policy: "full" });
  });

});
