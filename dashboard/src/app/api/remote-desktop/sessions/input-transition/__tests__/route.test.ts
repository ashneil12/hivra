import { NextRequest } from "next/server";

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "test-client"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  SESSION_TOKEN_RE: /^hrs1_[A-Za-z0-9_-]{43}$/,
  confirmRemoteDesktopInputTransitionByToken: jest.fn(),
}));

import { confirmRemoteDesktopInputTransitionByToken } from "@/lib/remote-computers/session-broker";
import { POST } from "../route";

const TOKEN = `hrs1_${"a".repeat(43)}`;
const receipt = {
  protocol: "hivra-remote-desktop-input-v1",
  action: "agent-input-suspended",
  sessionId: "11111111-1111-4111-8111-111111111111",
  computerKind: "hivra-agent",
  computerId: "22222222-2222-4222-8222-222222222222",
  capabilityGeneration: "33333333-3333-4333-8333-333333333333",
  transport: "selkies-websocket",
  agentInputSuspended: true,
  controllerCount: 1,
  observedAt: "2026-09-01T12:00:00.000Z",
};

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/sessions/input-transition", {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/remote-desktop/sessions/input-transition", () => {
  beforeEach(() => jest.clearAllMocks());

  it("confirms a strictly shaped guest receipt with the bearer", async () => {
    jest.mocked(confirmRemoteDesktopInputTransitionByToken).mockResolvedValue({ ok: true });
    const response = await POST(request(receipt));
    expect(response.status).toBe(200);
    expect(confirmRemoteDesktopInputTransitionByToken).toHaveBeenCalledWith({
      sessionToken: TOKEN,
      receipt,
    });
  });

  it("rejects browser ambient authority and URL capabilities", async () => {
    expect((await POST(request(receipt, { origin: "https://canary.hermesos.cloud" }))).status).toBe(403);
    const withQuery = new NextRequest(
      "https://canary.hermesos.cloud/api/remote-desktop/sessions/input-transition?token=x",
      { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify(receipt) },
    );
    expect((await POST(withQuery)).status).toBe(403);
    expect(confirmRemoteDesktopInputTransitionByToken).not.toHaveBeenCalled();
  });

  it("rejects input state that contradicts the transition", async () => {
    expect((await POST(request({ ...receipt, agentInputSuspended: false }))).status).toBe(400);
    expect((await POST(request({ ...receipt, controllerCount: 0 }))).status).toBe(400);
    expect(confirmRemoteDesktopInputTransitionByToken).not.toHaveBeenCalled();
  });

  it("does not expose the broker failure reason", async () => {
    jest.mocked(confirmRemoteDesktopInputTransitionByToken).mockResolvedValue({
      ok: false,
      status: 401,
      code: "denied",
      error: "private detail",
    });
    const response = await POST(request(receipt));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ confirmed: false });
  });
});
