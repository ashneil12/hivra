import { NextRequest } from "next/server";

import { DELETE, POST } from "../route";
import { auth } from "@clerk/nextjs/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isExpoPushToken } from "@/lib/push/expo-push";

jest.mock("@clerk/nextjs/server", () => ({
  auth: jest.fn(),
}));
jest.mock("@/lib/supabase", () => ({ supabaseAdmin: require("@/test-utils/supabase").createSupabaseMock().admin }));;
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/push/expo-push", () => ({
  isExpoPushToken: jest.fn(),
}));

const captureMock = jest.fn();
const flushMock = jest.fn();
jest.mock("@/lib/posthog", () => ({
  posthogClient: {
    capture: (...args: unknown[]) => captureMock(...args),
    flush: (...args: unknown[]) => flushMock(...args),
  },
}));

const mockedAuth = auth as unknown as jest.Mock;
const mockedFrom = supabaseAdmin!.from as jest.Mock;
const mockedIsToken = isExpoPushToken as jest.Mock;

const TOKEN = "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]";

function postRequest(body: unknown) {
  return new NextRequest("http://localhost/api/mobile/push-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function deleteRequest(body: unknown) {
  return new NextRequest("http://localhost/api/mobile/push-tokens", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedAuth.mockResolvedValue({ userId: "user_123" });
  mockedIsToken.mockReturnValue(true);
  flushMock.mockResolvedValue(undefined);
});

describe("POST /api/mobile/push-tokens", () => {
  it("requires a Clerk session", async () => {
    mockedAuth.mockResolvedValue({ userId: null });
    const response = await POST(postRequest({ expoPushToken: TOKEN }));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed Expo token", async () => {
    mockedIsToken.mockReturnValue(false);
    const response = await POST(postRequest({ expoPushToken: "not-a-token" }));
    expect(response.status).toBe(400);
    expect(mockedFrom).not.toHaveBeenCalled();
  });

  it("upserts on the token, re-enabling and reassigning it to the current user", async () => {
    const upsertMock = jest.fn().mockResolvedValue({ error: null });
    mockedFrom.mockReturnValue({ upsert: upsertMock });

    const response = await POST(postRequest({ expoPushToken: TOKEN, platform: "ios" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ registered: true });
    expect(mockedFrom).toHaveBeenCalledWith("device_tokens");
    expect(upsertMock).toHaveBeenCalledWith(
      {
        user_id: "user_123",
        expo_push_token: TOKEN,
        platform: "ios",
        enabled: true,
        last_seen_at: expect.any(String),
      },
      { onConflict: "expo_push_token" }
    );
  });

  it("captures push_token_registered with a stable $insert_id and flushes (box_created pattern)", async () => {
    mockedFrom.mockReturnValue({ upsert: jest.fn().mockResolvedValue({ error: null }) });

    await POST(postRequest({ expoPushToken: TOKEN }));
    await POST(postRequest({ expoPushToken: TOKEN }));

    expect(captureMock).toHaveBeenCalledTimes(2);
    const [first, second] = captureMock.mock.calls.map(([evt]) => evt);
    expect(first).toMatchObject({
      distinctId: "user_123",
      event: "push_token_registered",
      properties: expect.objectContaining({
        platform: "ios",
        $insert_id: expect.stringMatching(/^push_token_registered_user_123_/),
      }),
    });
    // Same user + same token → same $insert_id, so re-registrations collapse.
    expect(second.properties.$insert_id).toBe(first.properties.$insert_id);
    expect(flushMock).toHaveBeenCalledTimes(2);
  });

  it("returns 500 when the upsert fails", async () => {
    mockedFrom.mockReturnValue({
      upsert: jest.fn().mockResolvedValue({ error: { message: "db down" } }),
    });
    const response = await POST(postRequest({ expoPushToken: TOKEN }));
    expect(response.status).toBe(500);
    expect(captureMock).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/mobile/push-tokens", () => {
  it("disables the caller's token row (owner-scoped, soft off)", async () => {
    const eq2 = jest.fn().mockResolvedValue({ error: null });
    const eq1 = jest.fn().mockReturnValue({ eq: eq2 });
    const updateMock = jest.fn().mockReturnValue({ eq: eq1 });
    mockedFrom.mockReturnValue({ update: updateMock });

    const response = await DELETE(deleteRequest({ expoPushToken: TOKEN }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({ disabled: true });
    expect(updateMock).toHaveBeenCalledWith({ enabled: false });
    expect(eq1).toHaveBeenCalledWith("user_id", "user_123");
    expect(eq2).toHaveBeenCalledWith("expo_push_token", TOKEN);
  });

  it("requires a Clerk session", async () => {
    mockedAuth.mockResolvedValue({ userId: null });
    const response = await DELETE(deleteRequest({ expoPushToken: TOKEN }));
    expect(response.status).toBe(401);
  });

  it("rejects a body without a token", async () => {
    const response = await DELETE(deleteRequest({}));
    expect(response.status).toBe(400);
  });
});
