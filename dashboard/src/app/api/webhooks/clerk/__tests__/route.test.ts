import crypto from "crypto";
import { stopDeletedUserInstances } from "@/lib/recovery/stop-deleted-user-instances";
jest.mock("@/lib/recovery/stop-deleted-user-instances", () => ({ stopDeletedUserInstances: jest.fn() }));
import { after, NextRequest } from "next/server";

import { POST } from "../route";
import { syncClerkUserToAnnouncementAudience } from "@/lib/email/resend-announcement-sync";
import { sendWelcomeEmail } from "@/lib/email/welcome";

jest.mock("@/lib/email/resend-announcement-sync", () => ({
  syncClerkUserToAnnouncementAudience: jest.fn(),
}));

// `after` only exists inside a request scope; run its callbacks inline so the
// welcome send and the audience sync can be asserted after POST resolves.
jest.mock("next/server", () => ({
  ...jest.requireActual("next/server"),
  after: jest.fn(),
}));

jest.mock("@/lib/email/welcome", () => ({
  sendWelcomeEmail: jest.fn(),
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

  const mockedWelcome = sendWelcomeEmail as jest.MockedFunction<typeof sendWelcomeEmail>;

  beforeEach(() => {
    jest.clearAllMocks();
    (after as unknown as jest.Mock).mockImplementation((callback: () => unknown) => {
      void callback();
    });
    mockedWelcome.mockResolvedValue({ sent: true } as Awaited<ReturnType<typeof sendWelcomeEmail>>);
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

  it("stops only the deleted identity before acknowledging the signed event", async () => {
    (stopDeletedUserInstances as jest.Mock).mockResolvedValue({ stopped: 1 });
    const response = await POST(makeRequest({ type: "user.deleted", data: { id: "user_old" } }));
    expect(response.status).toBe(200);
    expect(stopDeletedUserInstances).toHaveBeenCalledWith("user_old");
    expect(mockedSync).not.toHaveBeenCalled();
  });

  it("returns 503 on shutdown failure so Clerk retries delivery", async () => {
    (stopDeletedUserInstances as jest.Mock).mockRejectedValue(new Error("provider unavailable"));
    const response = await POST(makeRequest({ type: "user.deleted", data: { id: "user_old" } }));
    expect(response.status).toBe(503);
  });

  it("rejects unsigned deletion and invalid identities without touching runtimes", async () => {
    const unsigned = await POST(makeRequest({ type: "user.deleted", data: { id: "user_old" } }, { "svix-signature": "v1,bad" }));
    const invalid = await POST(makeRequest({ type: "user.deleted", data: {} }));
    expect(unsigned.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(stopDeletedUserInstances).not.toHaveBeenCalled();
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

  it("does not send the welcome to an address Clerk has not verified", async () => {
    const user = {
      id: "user_new",
      first_name: "Ash",
      primary_email_address_id: "email_unverified",
      email_addresses: [
        { id: "email_unverified", email_address: "victim@gmail.com", verification: { status: "unverified" } },
      ],
    };

    const response = await POST(makeRequest({ type: "user.created", data: user }));

    expect(response.status).toBe(200);
    expect(mockedWelcome).not.toHaveBeenCalled();
  });

  it("welcomes the verified secondary address when the primary is unverified", async () => {
    const user = {
      id: "user_mixed",
      first_name: "Ash",
      primary_email_address_id: "email_primary",
      email_addresses: [
        { id: "email_primary", email_address: "typed-not-proven@gmail.com", verification: { status: "unverified" } },
        { id: "email_secondary", email_address: "proven@gmail.com", verification: { status: "verified" } },
      ],
    };

    const response = await POST(makeRequest({ type: "user.created", data: user }));

    expect(response.status).toBe(200);
    expect(mockedWelcome).toHaveBeenCalledTimes(1);
    expect(mockedWelcome).toHaveBeenCalledWith({ email: "proven@gmail.com", firstName: "Ash" });
  });

  it("welcomes a verified primary address (control)", async () => {
    const user = {
      id: "user_ok",
      first_name: "Ash",
      primary_email_address_id: "email_123",
      email_addresses: [
        { id: "email_123", email_address: "Ash@Example.com", verification: { status: "verified" } },
      ],
    };

    await POST(makeRequest({ type: "user.created", data: user }));

    expect(mockedWelcome).toHaveBeenCalledWith({ email: "ash@example.com", firstName: "Ash" });
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
