/** @jest-environment node */
const mockSend = jest.fn();
const mockGetUser = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } })),
}));
jest.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUser: (...args: unknown[]) => mockGetUser(...args) } }) }));
jest.mock("@/lib/logger", () => ({ log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { sendHermesMoveNoticeEmail, sendHermesMovedEmail } from "@/lib/email/hermes-move";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv, RESEND_API_KEY: "re_test" };
  mockSend.mockReset().mockResolvedValue({ error: null });
  mockGetUser.mockReset().mockResolvedValue({ primaryEmailAddressId: "email_1", emailAddresses: [{ id: "email_1", emailAddress: "owner@example.com", verification: { status: "verified" } }] });
});
afterAll(() => { process.env = originalEnv; });

const notice = { userId: "user_1", agentName: "Ada", moveAfter: "2026-11-13T09:00:00.000Z" };
const moved = { userId: "user_1", agentName: "Ada", agentId: "agent-1", undoUntil: "2026-11-20T09:00:00.000Z" };

describe("hermes move emails", () => {
  it("sends the notice to the verified owner address", async () => {
    expect(await sendHermesMoveNoticeEmail(notice)).toEqual({ sent: true });
    const [msg] = mockSend.mock.calls[0] as [{ to: string; subject: string; text: string; html: string }];
    expect(msg.to).toBe("owner@example.com");
    expect(msg.subject).toBe("Your agent Ada moves to the official Hermes tomorrow");
    expect(msg.text).toContain("after 13 November 2026, 09:00 UTC");
    expect(msg.text).toMatch(/offline for about 15 minutes/);
    expect(msg.text).toMatch(/kept for 7 days/);
  });

  it("sends the moved email with the update command and agent page link", async () => {
    expect(await sendHermesMovedEmail(moved)).toEqual({ sent: true });
    const [msg] = mockSend.mock.calls[0] as [{ subject: string; text: string; html: string }];
    expect(msg.subject).toBe("Ada has moved to the official Hermes");
    expect(msg.text).toContain("`hermes update`");
    expect(msg.text).toContain("until 20 November 2026, 09:00 UTC");
    expect(msg.text).toMatch(/\/dashboard\/agent\/agent-1/);
    expect(msg.html).toMatch(/href="[^"]*\/dashboard\/agent\/agent-1"/);
  });

  it("escapes the agent name in html", async () => {
    await sendHermesMoveNoticeEmail({ ...notice, agentName: '<img src=x onerror="a">' });
    await sendHermesMovedEmail({ ...moved, agentName: '<img src=x onerror="a">' });
    for (const call of mockSend.mock.calls) {
      const html = (call[0] as { html: string }).html;
      expect(html).not.toContain("<img");
      expect(html).toContain("&lt;img src=x onerror=&quot;a&quot;&gt;");
    }
  });

  it.each([
    ["no API key", () => { delete process.env.RESEND_API_KEY; }, "not_configured"],
    ["no email address", () => mockGetUser.mockResolvedValue({ emailAddresses: [] }), "no_email"],
    ["an unverified address", () => mockGetUser.mockResolvedValue({ primaryEmailAddressId: "email_1", emailAddresses: [{ id: "email_1", emailAddress: "x@example.com", verification: { status: "unverified" } }] }), "no_email"],
    ["Resend rejecting it", () => mockSend.mockResolvedValue({ error: { name: "x", message: "bad" } }), "send_failed"],
    ["Resend throwing", () => mockSend.mockRejectedValue(new Error("network")), "send_failed"],
  ])("returns not sent, and never throws, for %s", async (_n, arrange, reason) => {
    arrange();
    expect(await sendHermesMoveNoticeEmail(notice)).toEqual({ sent: false, reason });
    expect(await sendHermesMovedEmail(moved)).toEqual({ sent: false, reason });
  });
});
