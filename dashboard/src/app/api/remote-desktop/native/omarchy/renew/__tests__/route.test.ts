/** @jest-environment node */

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { renewOmarchyNativeSession } from "@/lib/remote-computers/omarchy-native-renewal";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn(() => ({ success: true })) }));
jest.mock("@/lib/remote-computers/omarchy-native-renewal", () => ({ renewOmarchyNativeSession: jest.fn() }));

const body = {
  computerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  activationId: "44444444-4444-4444-8444-444444444444",
  renewalId: "88888888-8888-4888-8888-888888888888",
};

function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/native/omarchy/renew", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(value),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: "user_fixture" } as never);
  jest.mocked(renewOmarchyNativeSession).mockResolvedValue({
    ok: true, ...body, renewalCount: 1, expiresAt: "2026-09-08T10:06:00.000Z",
    continuousExpiresAt: "2026-09-08T21:59:59.000Z", desktopReady: true,
  });
});

it("renews only the authenticated owner's exact activation", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, data: { renewalCount: 1 } });
  expect(renewOmarchyNativeSession).toHaveBeenCalledWith("user_fixture", body);
});

it("rejects cross-origin and extra-field requests before renewal", async () => {
  expect((await POST(request(body, { origin: "https://attacker.invalid" }))).status).toBe(403);
  expect((await POST(request({ ...body, ttlSeconds: 300 }))).status).toBe(400);
  expect(renewOmarchyNativeSession).not.toHaveBeenCalled();
});

it("retains the current deadline when guest renewal is uncertain", async () => {
  jest.mocked(renewOmarchyNativeSession).mockResolvedValue({ ok: false, code: "renewal_uncertain" });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ success: false, code: "renewal_uncertain" });
});
