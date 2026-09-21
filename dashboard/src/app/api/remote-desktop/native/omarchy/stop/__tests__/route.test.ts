/** @jest-environment node */

import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";

import { stopOmarchyNativeSession } from "@/lib/remote-computers/omarchy-native-stop";
import { POST } from "../route";

jest.mock("@clerk/nextjs/server", () => ({ auth: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ enforceRateLimit: jest.fn(() => ({ success: true })) }));
jest.mock("@/lib/remote-computers/omarchy-native-stop", () => ({ stopOmarchyNativeSession: jest.fn() }));

const body = {
  computerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "33333333-3333-4333-8333-333333333333",
  activationId: "44444444-4444-4444-8444-444444444444",
};

function request(value: unknown = body, headers: Record<string, string> = {}) {
  return new NextRequest("https://canary.hermesos.cloud/api/remote-desktop/native/omarchy/stop", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://canary.hermesos.cloud",
      "sec-fetch-site": "same-origin", ...headers },
    body: JSON.stringify(value),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(auth).mockResolvedValue({ userId: "user_fixture" } as never);
  jest.mocked(stopOmarchyNativeSession).mockResolvedValue({
    ok: true, ...body, controllerReleased: true, desktopReady: false,
  });
});

it("stops only the authenticated owner's exact activation", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, data: { controllerReleased: true } });
  expect(stopOmarchyNativeSession).toHaveBeenCalledWith("user_fixture", body);
});

it("rejects cross-origin and extra-field requests before stop", async () => {
  expect((await POST(request(body, { origin: "https://attacker.invalid" }))).status).toBe(403);
  expect((await POST(request({ ...body, command: "/tmp/run" }))).status).toBe(400);
  expect(stopOmarchyNativeSession).not.toHaveBeenCalled();
});

it("reports an uncertain guest stop as a held activation", async () => {
  jest.mocked(stopOmarchyNativeSession).mockResolvedValue({ ok: false, code: "stop_uncertain" });
  const response = await POST(request());
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ success: false, code: "stop_uncertain" });
});
