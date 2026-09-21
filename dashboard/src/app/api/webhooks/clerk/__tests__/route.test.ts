import crypto from "crypto";
import { NextRequest } from "next/server";

import { POST } from "../route";
import { syncClerkUserToAnnouncementAudience } from "@/lib/email/resend-announcement-sync";

jest.mock("@/lib/email/resend-announcement-sync", () => ({
  syncClerkUserToAnnouncementAudience: jest.fn(),
}));

function signPayload(params: {
  payload: string;
  secret: string;
  svixId: string;
  svixTimestamp: string;
}) {
  const rawSecret = params.secret.replace(/^whsec_/, "");
  return crypto
    .createHmac("sha256", Buffer.from(rawSecret, "base64"))
    .update(`${params.svixId}.${params.svixTimestamp}.${params.payload}`)
    .digest("base64");
}

describe("POST /api/webhooks/clerk", () => {
  const originalEnv = process.env;
  const secret = `whsec_${Buffer.from("test-secret").toString("base64")}`;
  const mockedSync = syncClerkUserToAnnouncementAudience as jest.MockedFunction<
    typeof syncClerkUserToAnnouncementAudience
  >;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    process.env = { ...originalEnv, CLERK_WEBHOOK_SECRET: secret };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  function makeRequest(payload: unknown, overrides: Record<string, string> = {}) {
    const body = JSON.stringify(payload);
    const svixId = "msg_123";
    const svixTimestamp = "1700000000";
    const signature = signPayload({ payload: body, secret, svixId, svixTimestamp });

    return new NextRequest("http://localhost/api/webhooks/clerk", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTimestamp,
        "svix-signature": `v1,${signature}`,
        ...overrides,
      },
    });
  }

  it("syncs Resend audience on supported user events", async () => {
    mockedSync.mockResolvedValue({
      skipped: false,
      email: "ash@example.com",
      action: "created",
      unsubscribed: false,
    });

    const user = {
      id: "user_123",
      primary_email_address_id: "email_123",
      email_addresses: [{ id: "email_123", email_address: "ash@example.com" }],
    };
    const response = await POST(makeRequest({ type: "user.created", data: user }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.received).toBe(true);
    expect(mockedSync).toHaveBeenCalledWith(user);
  });

  it("rejects invalid signatures before syncing", async () => {
    const response = await POST(
      makeRequest(
        {
          type: "user.created",
          data: { id: "user_123" },
        },
        { "svix-signature": "v1,bad" },
      ),
    );

    expect(response.status).toBe(400);
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("ignores unsupported Clerk events", async () => {
    const response = await POST(
      makeRequest({ type: "session.created", data: { id: "sess_123" } }),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data).toEqual({
      received: true,
      skipped: true,
      reason: "unsupported_event",
    });
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("fails closed when the webhook secret is missing", async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;

    const response = await POST(
      new NextRequest("http://localhost/api/webhooks/clerk", {
        method: "POST",
        body: "{}",
      }),
    );

    expect(response.status).toBe(500);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});
