/**
 * Deletion warning and final reminder content tests. Locks in that a person
 * whose agent is suspended for want of a paid plan is told payment is needed
 * (the cold-storage emails share the rule, because their cohort includes lapsed payers):
 *   - never "log in and resume", which a 402 on Start makes false
 *   - never "idle", which blames a payer for something they did not do
 *   - the call to action opens Billing, not the dashboard
 */

const mockResendSend = jest.fn();
jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockResendSend } })),
}));
jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());
jest.mock("@/lib/ops-events", () => ({ reportOpsEvent: jest.fn() }));

import * as finalReminder from "@/lib/email/agent-deletion-final-reminder";
import * as warning from "@/lib/email/agent-deletion-warning";
import { sendColdArchivedEmail, sendColdPendingDeletionEmail } from "@/lib/email/cold-storage";

const BILLING = "https://hivra.cloud/dashboard/billing";

describe("agent deletion warning", () => {
  const params = { email: "u@example.com", firstName: "Sam", deletionDate: "2026-11-05", daysRemaining: 5 };

  it("says no paid plan is active and how to keep the agent", () => {
    const text = warning.buildText(params);
    expect(text).toContain("because no paid plan is active on your account");
    expect(text).toContain("permanently deleted in 5 days, on 2026-11-05");
    expect(text).toContain(
      "To keep it, pay any open invoice or choose a plan in Billing, then start the agent again. It cannot be started until a plan is active."
    );
    expect(text).toContain(`Open Billing → ${BILLING}`);
  });

  it("does not tell a payer to log in and resume, or call the agent idle", () => {
    for (const body of [warning.buildText(params), warning.buildHtml(params)]) {
      expect(body).not.toMatch(/log in and resume|just log in|resume it|idle|Log in to keep it|tidy on the host/i);
    }
  });

  it("has no em or en dash in the text or the html", () => {
    for (const body of [warning.buildText(params), warning.buildHtml(params)]) {
      expect(body).not.toMatch(/[\u2013\u2014]/);
    }
  });

  it("opens Billing from the button", () => {
    const html = warning.buildHtml(params);
    expect(html).toContain(`href="${BILLING}"`);
    expect(html).toContain("Open Billing");
    expect(html).toContain("because no paid plan is active on your account");
  });
});

describe("agent deletion final reminder", () => {
  const params = { email: "u@example.com", firstName: "Sam", deletionDate: "2026-11-05", hoursRemaining: 24 };

  it("says payment is needed before the date, in the text and the html", () => {
    for (const body of [finalReminder.buildText(params), finalReminder.buildHtml(params)]) {
      expect(body).toContain("because no paid plan is active on your account");
      expect(body).toContain("pay any open invoice or choose a plan in Billing before then");
      expect(body).toContain("It cannot be started until a plan is active.");
    }
    expect(finalReminder.buildHtml(params)).toContain(`href="${BILLING}"`);
  });

  it("does not tell a payer to log in and resume, or call the agent idle", () => {
    for (const body of [finalReminder.buildText(params), finalReminder.buildHtml(params)]) {
      expect(body).not.toMatch(/log in and resume|resume any time|idle/i);
    }
  });

  it("has no em or en dash in the text or the html", () => {
    for (const body of [finalReminder.buildText(params), finalReminder.buildHtml(params)]) {
      expect(body).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("cold-storage emails", () => {
  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.RESEND_API_KEY = "re_test";
    mockResendSend.mockResolvedValue({ data: { id: "re_1" }, error: null });
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  const base = { email: "u@example.com", firstName: "Sam", agentName: "Scout", idempotencyKey: "k" };
  const PLAN_LINE =
    "If no paid plan is active on your account, pay any open invoice or choose a plan in Billing first, because it cannot be started until one is";

  it("pending deletion: says Start needs a plan, and the button opens Billing", async () => {
    await sendColdPendingDeletionEmail({
      ...base,
      daysUntilDeletion: 5,
      scheduledDeletionDateIso: "2026-11-05T00:00:00.000Z",
    });
    const sent = mockResendSend.mock.calls[0][0] as { text: string; html: string; subject: string };
    for (const body of [sent.text, sent.html]) {
      expect(body).toContain(PLAN_LINE);
      expect(body).not.toMatch(/Bring it back by clicking Start|Restore my agent/);
    }
    expect(sent.html).toContain(`href="${BILLING}"`);
    expect(sent.html).toContain("Open Billing");
    expect(`${sent.subject}\n${sent.text}\n${sent.html}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("archived: tells a lapsed payer to choose a plan before pressing Start", async () => {
    await sendColdArchivedEmail(base);
    const sent = mockResendSend.mock.calls[0][0] as { text: string; html: string; subject: string };
    for (const body of [sent.text, sent.html]) {
      expect(body).toContain(PLAN_LINE);
      expect(body).not.toMatch(/hit Start/);
    }
    expect(`${sent.subject}\n${sent.text}\n${sent.html}`).not.toMatch(/[\u2013\u2014]/);
  });
});
