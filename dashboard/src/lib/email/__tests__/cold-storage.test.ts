/**
 * Cold-storage email escaping tests. Locks in:
 *   - the user's first name and agent name reach the HTML body escaped, so a
 *     hostile name renders as text instead of markup
 *   - the plain-text bodies keep the raw values
 */

const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: sendMock },
  })),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import {
  sendColdArchivedEmail,
  sendColdDeletedEmail,
  sendColdPendingDeletionEmail,
} from "@/lib/email/cold-storage";

const HOSTILE = {
  email: "user@example.com",
  firstName: '<img src=x onerror="alert(1)">',
  agentName: "<script>x</script>",
};

describe("cold-storage emails escape user-supplied names in HTML", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, RESEND_API_KEY: "re_test_key" };
    sendMock.mockResolvedValue({ data: { id: "email_1" }, error: null });
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    ["archived", () => sendColdArchivedEmail({ ...HOSTILE, idempotencyKey: "k-archived" })],
    [
      "pending deletion",
      () =>
        sendColdPendingDeletionEmail({
          ...HOSTILE,
          idempotencyKey: "k-pending",
          daysUntilDeletion: 5,
          scheduledDeletionDateIso: "2026-11-01T00:00:00.000Z",
        }),
    ],
    [
      "final notice",
      () =>
        sendColdPendingDeletionEmail({
          ...HOSTILE,
          idempotencyKey: "k-final",
          daysUntilDeletion: 1,
          scheduledDeletionDateIso: "2026-11-01T00:00:00.000Z",
        }),
    ],
    ["deleted", () => sendColdDeletedEmail({ ...HOSTILE, idempotencyKey: "k-deleted" })],
  ])("%s: the names reach the HTML escaped, not as markup", async (_label, send) => {
    await send();
    const payload = sendMock.mock.calls[0][0] as { html: string };
    expect(payload.html).not.toContain("<img src=x");
    expect(payload.html).not.toContain("<script>x</script>");
    expect(payload.html).toContain("Hey &lt;img src=x onerror=&quot;alert(1)&quot;&gt;,");
    expect(payload.html).toContain("&lt;script&gt;x&lt;/script&gt;");
  });

  it("keeps the raw names in the plain-text body", async () => {
    await sendColdArchivedEmail({ ...HOSTILE, idempotencyKey: "k-text" });
    const payload = sendMock.mock.calls[0][0] as { text: string };
    expect(payload.text).toContain('Hey <img src=x onerror="alert(1)">,');
    expect(payload.text).toContain('your agent "<script>x</script>"');
  });
});
