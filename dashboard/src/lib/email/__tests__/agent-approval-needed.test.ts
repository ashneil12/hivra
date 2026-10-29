/** @jest-environment node */
/**
 * The approval email is sent to the owner's Clerk-verified address. Its HTML must
 * still escape the names the user typed (first name, agent name), as the other
 * customer emails do (F106).
 */

const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({
    emails: { send: (...args: unknown[]) => mockSend(...args) },
  })),
}));

jest.mock("@/lib/logger", () => require("@/test-utils").createLoggerMock());

import { sendAgentApprovalNeededEmail } from "@/lib/email/agent-approval-needed";

const originalEnv = { ...process.env };

async function sentHtml(params: Partial<Parameters<typeof sendAgentApprovalNeededEmail>[0]>): Promise<string> {
  await sendAgentApprovalNeededEmail({
    email: "owner@example.com",
    instanceId: "inst_1",
    idempotencyKey: "pending-prompt:row_1",
    ...params,
  });
  const [message] = mockSend.mock.calls[0] as [{ html: string }];
  return message.html;
}

describe("agent approval email escapes user-typed text", () => {
  beforeEach(() => {
    process.env = { ...originalEnv, RESEND_API_KEY: "re_test" };
    mockSend.mockReset().mockResolvedValue({ data: { id: "msg_1" }, error: null });
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("escapes markup in the first name", async () => {
    const html = await sentHtml({
      firstName: '<a href="https://evil.example/x">Sam</a>',
      agentName: "Atlas",
    });

    expect(html).not.toContain('<a href="https://evil.example/x">');
    expect(html).toContain("&lt;a href=&quot;https://evil.example/x&quot;&gt;Sam&lt;/a&gt;");
  });

  it("escapes markup in the agent name, in the title and the body", async () => {
    const html = await sentHtml({
      firstName: "Sam",
      agentName: "<img src=x onerror=alert(1)>",
    });

    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // The title and the body both carry the label; neither may hold raw markup.
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("still sends the plain label for an ordinary agent name (control)", async () => {
    const html = await sentHtml({ firstName: "Sam", agentName: "Atlas" });

    expect(html).toContain("Hey Sam,");
    expect(html).toContain("Atlas");
  });
});
