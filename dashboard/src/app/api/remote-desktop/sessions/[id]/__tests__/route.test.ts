import { NextRequest } from "next/server";

import { DELETE } from "../route";
import { auth } from "@clerk/nextjs/server";
import { revokeRemoteDesktopSession } from "@/lib/remote-computers/session-broker";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn(() => ({ success: true })) }));
jest.mock("@/lib/remote-computers/session-broker", () => ({ revokeRemoteDesktopSession: jest.fn() }));

const SESSION_ID = "018f6d3c-1d91-7c65-9d86-37fc915b8379";
function request(origin = "https://canary.hermesos.cloud") {
  return new NextRequest(`https://canary.hermesos.cloud/api/remote-desktop/sessions/${SESSION_ID}`, {
    method: "DELETE",
    headers: { origin, "sec-fetch-site": "same-origin" },
  });
}

describe("DELETE /api/remote-desktop/sessions/[id]", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (auth as unknown as jest.Mock).mockResolvedValue({ userId: "user-1" });
    (revokeRemoteDesktopSession as jest.Mock).mockResolvedValue({ ok: true, inputState: "release-pending" });
  });

  it("revokes the owner's exact session", async () => {
    const response = await DELETE(request(), { params: Promise.resolve({ id: SESSION_ID }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, data: { inputState: "release-pending" } });
    expect(revokeRemoteDesktopSession).toHaveBeenCalledWith({
      userId: "user-1",
      sessionId: SESSION_ID,
      reason: "user_revoked",
    });
  });

  it("rejects unauthenticated and cross-origin revocation", async () => {
    (auth as unknown as jest.Mock).mockResolvedValueOnce({ userId: null });
    expect((await DELETE(request(), { params: Promise.resolve({ id: SESSION_ID }) })).status).toBe(401);
    expect((await DELETE(request("https://attacker.example"), { params: Promise.resolve({ id: SESSION_ID }) })).status).toBe(403);
    expect(revokeRemoteDesktopSession).not.toHaveBeenCalled();
  });
});
