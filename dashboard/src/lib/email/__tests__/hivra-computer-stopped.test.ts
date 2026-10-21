/** @jest-environment node */
const mockSend = jest.fn();
const mockGetUser = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } })),
}));
jest.mock("@clerk/nextjs/server", () => ({ clerkClient: async () => ({ users: { getUser: (...args: unknown[]) => mockGetUser(...args) } }) }));

import { buildHivraComputerStoppedEmail, sendHivraComputerStoppedEmail } from "@/lib/email/hivra-computer-stopped";

const originalEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...originalEnv, RESEND_API_KEY: "re_test" };
  mockSend.mockReset().mockResolvedValue({ error: null });
  mockGetUser.mockReset().mockResolvedValue({ primaryEmailAddress: { emailAddress: "owner@example.com" } });
});
afterAll(() => { process.env = originalEnv; });

describe("the stopped-computer email", () => {
  it("says why, that nothing was deleted and what to do, with no deletion promise", () => {
    const { subject, text } = buildHivraComputerStoppedEmail({ computerName: "Desk" });
    expect(subject).toBe("Your Hivra computer was stopped");
    expect(text).toContain('"Desk"');
    expect(text).toMatch(/needs a paid plan and your account has none right now/);
    expect(text).toMatch(/Nothing was deleted/);
    expect(text).toMatch(/press Start/);
    expect(text).toMatch(/\/dashboard\/billing/);
    expect(text.replace("Nothing was deleted", "")).not.toMatch(/delet/i);
    expect(text).not.toMatch(new RegExp("[" + String.fromCharCode(0x2013, 0x2014) + "]"));
  });

  it("works without a computer name", () => {
    expect(buildHivraComputerStoppedEmail({}).text).toContain("Your Hivra computer was stopped because");
  });

  it("sends once to the owner's primary address with a per-computer idempotency key", async () => {
    const result = await sendHivraComputerStoppedEmail({ userId: "user_1", agentId: "agent-1", computerName: "Desk" });
    expect(result).toEqual({ sent: true });
    const [message, options] = mockSend.mock.calls[0] as [{ to: string; subject: string }, { idempotencyKey: string }];
    expect(message.to).toBe("owner@example.com");
    expect(options.idempotencyKey).toMatch(/^hivra-computer-stopped\/agent-1\/\d{4}-\d{2}-\d{2}$/);
  });

  it.each([
    ["no API key", () => { delete process.env.RESEND_API_KEY; }, "not_configured"],
    ["no email address", () => mockGetUser.mockResolvedValue({ emailAddresses: [] }), "no_email"],
    ["the owner lookup failing", () => mockGetUser.mockRejectedValue(new Error("clerk down")), "no_email"],
    ["Resend rejecting it", () => mockSend.mockResolvedValue({ error: { message: "bad" } }), "send_failed"],
    ["Resend throwing", () => mockSend.mockRejectedValue(new Error("network")), "send_failed"],
  ])("returns not sent, and never throws, for %s", async (_name, arrange, reason) => {
    arrange();
    expect(await sendHivraComputerStoppedEmail({ userId: "user_1", agentId: "agent-1" })).toMatchObject({ sent: false, reason });
  });
});
