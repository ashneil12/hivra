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
jest.mock("@/lib/hivra/agent-wake", () => ({
  ensureHivraAgentAwake: (...a: unknown[]) => mockEnsure(...a),
  MANAGED_WAKE_WORK_BUDGET_MS: 330_000,
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { maxDuration, POST } from "../route";

const ID = "00000000-0000-4000-8000-000000001022";
const params = { params: Promise.resolve({ id: ID }) };
const CANARY = {
  VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "canary.hermesos.cloud",
  VERCEL_GIT_COMMIT_REF: "canary", VERCEL_GIT_REPO_OWNER: "ashneil12", VERCEL_GIT_REPO_SLUG: "hivra",
};
const PAID_KVM = { id: ID, status: "running", deployment_mode: "hivra-managed", computer_substrate: "proxmox-kvm", seat_funding: "paid", type: "claude-code" };

function request(headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  return new NextRequest(`https://canary.hermesos.cloud/api/hivra/agents/${ID}/wake`, {
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
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "open", waitMs: 45_000, portableOwnerId: "user-1" }));
  });

  it("distinguishes a signed-in owner’s chat send from an owner-open wake", async () => {
    expect((await POST(request({}, { source: "chat" }), params)).status).toBe(200);
    expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action", portableOwnerId: "user-1" }));
    mockEnsure.mockClear();
    mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    expect((await POST(request({}, { source: "chat" }), params)).status).toBe(404);
    expect(mockEnsure).not.toHaveBeenCalled();
  });

  it.each(["claude-code", "codex"])("accepts typing wake for an owned paid Git Canary %s KVM", async (type) => {
    const env = jest.replaceProperty(process, "env", { ...process.env, ...CANARY });
    try {
      mockMaybeSingle.mockResolvedValueOnce({ data: { ...PAID_KVM, type }, error: null });
      expect((await POST(request({}, { source: "chat-typing" }), params)).status).toBe(200);
      expect(mockEq).toHaveBeenCalledWith("user_id", "user-1");
      expect(mockEnsure).toHaveBeenCalledWith(ID, expect.objectContaining({ trigger: "action", portableOwnerId: "user-1" }));
    } finally { env.restore(); }
  });

  it.each([
    ["production", { VERCEL_PROJECT_PRODUCTION_URL: "hivra.cloud" }, {}],
    ["preview", { VERCEL_ENV: "preview" }, {}],
    ["non-Git deployment", { VERCEL_GIT_COMMIT_REF: undefined }, {}],
    ["holder", {}, { seat_funding: "holder" }],
    ["offloaded", {}, { sleep_stored_at: "2026-11-28T12:00:00Z" }],
    ["provider VM", {}, { computer_substrate: "provider-vm" }],
    ["self-managed", {}, { deployment_mode: "self-managed" }],
    ["Hermes", {}, { type: "hermes" }],
    ["stopped", {}, { status: "stopped" }],
  ])("does not accept typing wake for %s even at the Canary request host", async (_reason, deployment, row) => {
    const env = jest.replaceProperty(process, "env", { ...process.env, ...CANARY, ...deployment });
    try {
      mockMaybeSingle.mockResolvedValueOnce({ data: { ...PAID_KVM, ...row }, error: null });
      expect((await POST(request({}, { source: "chat-typing" }), params)).status).toBe(403);
      expect(mockEnsure).not.toHaveBeenCalled();
    } finally { env.restore(); }
  });

  it("hands unfinished wake work to after()", async () => {
    const started = Date.now();
    mockEnsure.mockImplementation(async (_id: string, options: { onBackground: (work: Promise<unknown>) => void }) => {
      options.onBackground(Promise.resolve());
      return { state: "waking", reason: "in_progress" };
    });
    const response = await POST(request(), params);
    expect(response.status).toBe(202);
    expect((await response.json()).data).toEqual({ state: "waking" });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    const { workDeadlineMs } = mockEnsure.mock.calls[0][1] as { workDeadlineMs: number };
    expect(workDeadlineMs - started).toBeGreaterThanOrEqual(330_000);
    expect(workDeadlineMs - started).toBeLessThan(maxDuration * 1000 - 15_000);
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
