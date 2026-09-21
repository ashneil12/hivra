import { NextRequest } from "next/server";

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "test-client"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  SESSION_TOKEN_RE: /^hrs1_[A-Za-z0-9_-]{43}$/,
  revokeRemoteDesktopSessionByToken: jest.fn(),
}));

import { revokeRemoteDesktopSessionByToken } from "@/lib/remote-computers/session-broker";
import { POST } from "../route";

const TOKEN = `hrs1_${"b".repeat(43)}`;

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/sessions/terminate", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/remote-desktop/sessions/terminate", () => {
  beforeEach(() => jest.clearAllMocks());

  it("terminates only the bearer-bound guest session", async () => {
    jest.mocked(revokeRemoteDesktopSessionByToken).mockResolvedValue({ ok: true, inputState: "release-pending" });
    const response = await POST(request({ reason: "connection_closed" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: true, inputState: "release-pending" });
    expect(revokeRemoteDesktopSessionByToken).toHaveBeenCalledWith({
      sessionToken: TOKEN,
      reason: "connection_closed",
    });
  });

  it("rejects owner-only and browser channels", async () => {
    expect((await POST(request({ reason: "user_revoked" }))).status).toBe(400);
    expect((await POST(request({ reason: "connection_closed" }, { cookie: "ambient=1" }))).status).toBe(403);
    expect(revokeRemoteDesktopSessionByToken).not.toHaveBeenCalled();
  });

  it("does not expose termination failures", async () => {
    jest.mocked(revokeRemoteDesktopSessionByToken).mockResolvedValue({
      ok: false,
      status: 401,
      code: "denied",
      error: "private detail",
    });
    const response = await POST(request({ reason: "security_event" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ revoked: false });
  });
});
