/**
 * Payment-failed (dunning) recovery email content tests. Locks in:
 *   - the Ash-approved copy, verbatim (subject, body beats, sign-off)
 *   - first-name derivation from the Stripe customer name
 *   - the personal "Ash at Hivra" sender + monitored reply-to
 *   - the hosted-invoice link in both text and HTML (escaped in HTML)
 *   - send() fails soft when Resend isn't configured
 */

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

const mockResendSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: mockResendSend },
  })),
}));

import {
  PAYMENT_FAILED_RECOVERY_FROM,
  buildPaymentFailedRecoveryEmail,
  firstNameFromCustomerName,
  paymentFailedRecoveryEmailKey,
  sendPaymentFailedRecoveryEmail,
} from "@/lib/email/payment-failed-recovery";

const URL = "https://invoice.stripe.com/i/acct_1/test_abc123";

describe("firstNameFromCustomerName", () => {
  it("takes the first token, capitalized", () => {
    expect(firstNameFromCustomerName("john smith")).toBe("John");
    expect(firstNameFromCustomerName("  priya   raman  ")).toBe("Priya");
    expect(firstNameFromCustomerName("ALICE")).toBe("ALICE");
  });

  it("falls back to 'there' when Stripe has no usable name", () => {
    expect(firstNameFromCustomerName(null)).toBe("there");
    expect(firstNameFromCustomerName(undefined)).toBe("there");
    expect(firstNameFromCustomerName("   ")).toBe("there");
  });
});

describe("paymentFailedRecoveryEmailKey", () => {
  it("keys on the invoice id so dedupe is per invoice", () => {
    expect(paymentFailedRecoveryEmailKey("in_123")).toBe(
      "payment_failed_recovery_in_123"
    );
  });
});

describe("buildPaymentFailedRecoveryEmail", () => {
  const content = buildPaymentFailedRecoveryEmail({
    firstName: "John",
    hostedInvoiceUrl: URL,
  });

  it("uses the approved copy verbatim", () => {
    expect(content.subject).toBe("your agent hit a card snag");
    expect(content.text).toContain("Hey John,");
    expect(content.text).toContain(
      "Quick heads up. Your card didn't go through this month, so this cycle's payment failed."
    );
    expect(content.text).toContain(
      "Your agent is still running. Its memory, chats, and everything it's set up for you are safe. But if the card keeps failing, the box gets shut down automatically and all of that goes with it."
    );
    expect(content.text).toContain("The fix takes 30 seconds, no login needed:");
    expect(content.text).toContain(
      "Money tight or meant to cancel? Just reply and tell me. I read every email."
    );
    expect(content.text).toContain("Ash\nFounder, Hivra");
  });

  it("keeps the voice rules (no exclamation points, no hype)", () => {
    expect(content.subject).not.toContain("!");
    expect(content.text).not.toContain("!");
    expect(`${content.text}\n${content.html}`).not.toMatch(
      /unlock|supercharge|game-?chang/i
    );
  });

  it("puts the hosted invoice link in both text and HTML", () => {
    expect(content.text).toContain(URL);
    expect(content.html).toContain(`href="${URL}"`);
    expect(content.html).toContain("<!doctype html>");
  });

  it("HTML-escapes a customer-supplied name", () => {
    const hostile = buildPaymentFailedRecoveryEmail({
      firstName: "<script>",
      hostedInvoiceUrl: URL,
    });
    expect(hostile.html).not.toContain("<script>");
    expect(hostile.html).toContain("&lt;script&gt;");
  });
});

describe("sendPaymentFailedRecoveryEmail", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_REPLY_TO_EMAIL;
    mockResendSend.mockResolvedValue({ data: { id: "re_1" }, error: null });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("fails soft when RESEND_API_KEY is missing", async () => {
    const res = await sendPaymentFailedRecoveryEmail({
      email: "user@example.com",
      firstName: "John",
      hostedInvoiceUrl: URL,
      idempotencyKey: "payment_failed_recovery_in_123",
    });
    expect(res).toEqual({ sent: false, reason: "not_configured" });
    expect(mockResendSend).not.toHaveBeenCalled();
  });

  it("sends from 'Ash at Hivra', replies to the monitored inbox, and passes the invoice-keyed idempotencyKey", async () => {
    process.env.RESEND_API_KEY = "re_test";
    const res = await sendPaymentFailedRecoveryEmail({
      email: "user@example.com",
      firstName: "John",
      hostedInvoiceUrl: URL,
      idempotencyKey: "payment_failed_recovery_in_123",
    });
    expect(res).toEqual({ sent: true, messageId: "re_1" });
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    const [payload, options] = mockResendSend.mock.calls[0];
    expect(PAYMENT_FAILED_RECOVERY_FROM).toBe("Ash at Hivra <info@hermesos.cloud>");
    expect(payload).toMatchObject({
      from: "Ash at Hivra <info@hermesos.cloud>",
      to: "user@example.com",
      replyTo: "info@hermesos.cloud",
      subject: "your agent hit a card snag",
    });
    expect(payload.text).toContain(URL);
    expect(options).toEqual({ idempotencyKey: "payment_failed_recovery_in_123" });
  });

  it("reports send_failed when Resend rejects (e.g. a suppressed/bounced address)", async () => {
    process.env.RESEND_API_KEY = "re_test";
    mockResendSend.mockResolvedValue({
      data: null,
      error: { name: "validation_error", message: "suppressed recipient" },
    });
    const res = await sendPaymentFailedRecoveryEmail({
      email: "bounced@example.com",
      firstName: "John",
      hostedInvoiceUrl: URL,
      idempotencyKey: "payment_failed_recovery_in_123",
    });
    expect(res).toEqual({
      sent: false,
      reason: "send_failed",
      errorMessage: "suppressed recipient",
    });
  });
});
