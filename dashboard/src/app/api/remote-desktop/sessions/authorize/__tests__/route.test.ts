import { NextRequest } from "next/server";

import { POST } from "../route";
import { authorizeRemoteDesktopSession } from "@/lib/remote-computers/session-broker";

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  authorizeRemoteDesktopSession: jest.fn(),
  SESSION_TOKEN_RE: /^hrs1_[A-Za-z0-9_-]{43}$/,
}));

const token = `hrs1_${"t".repeat(43)}`;
const body = {
  computerKind: "hermes-instance",
  computerId: "018f6d3c-1d91-7c65-9d86-37fc915b8377",
  transport: "selkies-webrtc",
  wantsInput: true,
};
function request(headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/sessions/authorize", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/remote-desktop/sessions/authorize", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (authorizeRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: true,
      authorization: { status: "authorized", inputReady: true },
    });
  });

  it("authorizes a broker request without forwarding the bearer in the JSON body", async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ authorized: true, data: { inputReady: true } });
    expect(authorizeRemoteDesktopSession).toHaveBeenCalledWith({ sessionToken: token, ...body });
  });

  it("rejects browsers, cookies, query parameters, and malformed bearers", async () => {
    expect((await POST(request({ origin: "https://canary.hermesos.cloud" }))).status).toBe(403);
    expect((await POST(request({ cookie: "session=x" }))).status).toBe(403);
    expect((await POST(request({ authorization: "Bearer wrong" }))).status).toBe(401);
    expect(authorizeRemoteDesktopSession).not.toHaveBeenCalled();
  });

  it("returns only a generic denial when storage rejects the token", async () => {
    (authorizeRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      code: "denied",
      error: "Desktop session denied.",
    });
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ authorized: false });
  });
});
