import { NextRequest } from "next/server";

import { POST } from "../route";
import { renewRemoteDesktopSessionByToken } from "@/lib/remote-computers/session-broker";

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  renewRemoteDesktopSessionByToken: jest.fn(),
  SESSION_TOKEN_RE: /^hrs1_[A-Za-z0-9_-]{43}$/,
}));

const token = `hrs1_${"t".repeat(43)}`;
function request(headers: Record<string, string> = {}, body: unknown = { ttlSeconds: 240 }) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/sessions/renew", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/remote-desktop/sessions/renew", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (renewRemoteDesktopSessionByToken as jest.Mock).mockResolvedValue({
      ok: true,
      renewal: {
        sessionId: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
        expiresAt: "2026-09-01T12:04:00.000Z",
        continuousExpiresAt: "2026-09-02T00:00:00.000Z",
        renewalCount: 1,
      },
    });
  });

  it("renews a machine-only bearer without accepting it in the body", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ renewed: true, data: { renewalCount: 1 } });
    expect(renewRemoteDesktopSessionByToken).toHaveBeenCalledWith({ sessionToken: token, ttlMs: 240_000 });
  });

  it("rejects browser authority, cookies, query parameters, and malformed TTLs", async () => {
    expect((await POST(request({ origin: "https://canary.hermesos.cloud" }))).status).toBe(403);
    expect((await POST(request({ cookie: "session=x" }))).status).toBe(403);
    expect((await POST(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect((await POST(request({}, { ttlSeconds: 301 }))).status).toBe(400);
    expect(renewRemoteDesktopSessionByToken).not.toHaveBeenCalled();
  });

  it("returns only a generic denial when storage rejects renewal", async () => {
    (renewRemoteDesktopSessionByToken as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      code: "denied",
      error: "Desktop session renewal denied.",
    });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ renewed: false });
  });
});
