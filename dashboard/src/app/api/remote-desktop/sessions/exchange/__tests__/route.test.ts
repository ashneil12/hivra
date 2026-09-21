import { NextRequest } from "next/server";

import { POST } from "../route";
import { exchangeRemoteDesktopSession } from "@/lib/remote-computers/session-broker";

jest.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: jest.fn(() => ({ success: true })),
  getIP: jest.fn(() => "127.0.0.1"),
}));
jest.mock("@/lib/remote-computers/session-broker", () => ({
  exchangeRemoteDesktopSession: jest.fn(),
}));

const body = { exchangeCode: "e".repeat(43), verifier: "v".repeat(64) };
function request(headers: Record<string, string> = {}, url = "https://canary.hermesos.cloud/api/remote-desktop/sessions/exchange") {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/remote-desktop/sessions/exchange", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (exchangeRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: true,
      grant: { sessionToken: `hrs1_${"t".repeat(43)}`, inputReady: false },
    });
  });

  it("supports a native no-Origin exchange and a same-origin browser exchange", async () => {
    expect((await POST(request())).status).toBe(200);
    expect((await POST(request({
      origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin",
    }))).status).toBe(200);
    expect(exchangeRemoteDesktopSession).toHaveBeenCalledTimes(2);
  });

  it("rejects cross-site and URL-carried handoffs", async () => {
    expect((await POST(request({
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    }))).status).toBe(403);
    expect((await POST(request({}, "https://canary.hermesos.cloud/api/remote-desktop/sessions/exchange?code=secret"))).status).toBe(403);
    expect(exchangeRemoteDesktopSession).not.toHaveBeenCalled();
  });

  it("does not reveal whether an invalid handoff was unknown or malformed", async () => {
    (exchangeRemoteDesktopSession as jest.Mock).mockResolvedValue({
      ok: false,
      status: 400,
      code: "invalid",
      error: "Invalid desktop handoff.",
    });
    const response = await POST(request());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, error: "Invalid desktop handoff.", code: "invalid" });
  });
});
