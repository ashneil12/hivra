/**
 * Welcome-email suppression tests. Locks in:
 *   - internal non-receiving recipients (first-run-audit synthetic users and
 *     the hermesos.cloud / hivra.cloud placeholder domains, which have
 *     receiving disabled in Resend) never reach the Resend API — a send there
 *     hard-bounces and poisons sender reputation
 *   - suppression wins over the not-configured path (no key needed to skip)
 *   - real recipients still send, and the fail-soft not_configured path holds
 */

const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { isInternalNonReceivingRecipient, sendWelcomeEmail } from "@/lib/email/welcome";

describe("isInternalNonReceivingRecipient", () => {
  it.each([
    "firstrun-audit-a1b2c3@hermesos.cloud",
    "firstrun-audit-00ff@example.com",
    "anything@hermesos.cloud",
    "anything@hivra.cloud",
    "USER@HERMESOS.CLOUD",
    "FirstRun-Audit-AB@gmail.com",
    "  firstrun-audit-1@hivra.cloud  ",
  ])("suppresses %s", (email) => {
    expect(isInternalNonReceivingRecipient(email)).toBe(true);
  });

  it.each([
    "user@example.com",
    "ash@gmail.com",
    "user@nothermesos.cloud",
    "user@hermesos.cloud.evil.com",
    "not-firstrun-audit-x@example.com",
  ])("allows %s", (email) => {
    expect(isInternalNonReceivingRecipient(email)).toBe(false);
  });
});

describe("sendWelcomeEmail", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, RESEND_API_KEY: "re_test_key" };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("suppresses first-run-audit recipients without calling Resend", async () => {
    const res = await sendWelcomeEmail({ email: "firstrun-audit-deadbeef@hermesos.cloud" });
    expect(res).toEqual({ sent: false, reason: "internal_recipient" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("suppresses non-receiving placeholder domains without calling Resend", async () => {
    for (const email of ["someone@hermesos.cloud", "someone@hivra.cloud"]) {
      const res = await sendWelcomeEmail({ email });
      expect(res).toEqual({ sent: false, reason: "internal_recipient" });
    }
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("suppression wins even when Resend is not configured", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await sendWelcomeEmail({ email: "firstrun-audit-1@hermesos.cloud" });
    expect(res).toEqual({ sent: false, reason: "internal_recipient" });
  });

  it("sends to a real recipient", async () => {
    sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
    const res = await sendWelcomeEmail({ email: "user@example.com", firstName: "Sam" });
    expect(res).toEqual({ sent: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user@example.com",
        subject: "Welcome to Hivra",
      }),
    );
  });

  it("fails soft when RESEND_API_KEY is missing for a real recipient", async () => {
    delete process.env.RESEND_API_KEY;
    const res = await sendWelcomeEmail({ email: "user@example.com" });
    expect(res).toEqual({ sent: false, reason: "not_configured" });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
