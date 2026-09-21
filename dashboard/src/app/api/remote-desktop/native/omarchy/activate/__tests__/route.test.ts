import { NextRequest } from "next/server";

import { POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { activateOmarchyNativeSession } from "@/lib/remote-computers/omarchy-native-activation";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn(() => ({ success: true })) }));
jest.mock("@/lib/remote-computers/omarchy-native-activation", () => ({ activateOmarchyNativeSession: jest.fn() }));

const body = {
  computerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  sessionToken: `hrs1_${"t".repeat(43)}`,
};
function request(value: unknown = body, origin = "https://canary.hermesos.cloud") {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/native/omarchy/activate", {
    method: "POST",
    headers: { origin, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify(value),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: "user_fixture" } as never);
  jest.mocked(activateOmarchyNativeSession).mockResolvedValue({
    ok: true, sessionId: body.sessionId, activationId: "44444444-4444-4444-8444-444444444444",
    streamingMode: "hq", desktopReady: true, pairingVerified: true,
    guestBootId: "55555555-5555-4555-8555-555555555555",
    serverId: body.computerId, guestPrivateIpv4: "10.240.20.99", connectionIpv4: "198.51.100.11",
    serverCertificatePem: "-----BEGIN CERTIFICATE-----\nZml4dHVyZQ==\n-----END CERTIFICATE-----\n",
    serverCertificateSha256: "8".repeat(64),
  });
});

it("activates only the authenticated same-origin native session", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(activateOmarchyNativeSession).toHaveBeenCalledWith("user_fixture", body);
  expect((await response.json()).success).toBe(true);
});

it("rejects ambient, cross-origin, and malformed authority", async () => {
  jest.mocked(auth).mockResolvedValueOnce({ userId: null } as never);
  expect((await POST(request())).status).toBe(401);
  expect((await POST(request(body, "https://attacker.example"))).status).toBe(403);
  expect((await POST(request({ ...body, sessionToken: "bad" }))).status).toBe(400);
  expect(activateOmarchyNativeSession).not.toHaveBeenCalled();
});

it("holds an uncertain dispatch without reporting success", async () => {
  jest.mocked(activateOmarchyNativeSession).mockResolvedValueOnce({ ok: false, code: "activation_uncertain" });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ success: false, code: "activation_uncertain" });
  expect(activateOmarchyNativeSession).toHaveBeenCalledTimes(1);
});
