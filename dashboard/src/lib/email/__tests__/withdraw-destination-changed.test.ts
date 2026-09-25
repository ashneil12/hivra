/** @jest-environment node */
/**
 * The destination-change email is how an owner learns about a change they did
 * not make while the new address is still held: it must name both addresses,
 * say when the new one unlocks, and say what to do if it wasn't them.
 */

const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } })),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUser: async () => ({ primaryEmailAddress: { emailAddress: "owner@example.com" } }) },
  }),
}));

import { sendWithdrawDestinationChangedEmail } from "@/lib/email/withdraw-destination-changed";

const originalEnv = { ...process.env };
const changedAt = new Date("2026-09-25T10:00:00.000Z");
const availableAt = new Date("2026-09-26T10:00:00.000Z");

beforeEach(() => {
  process.env = { ...originalEnv, RESEND_API_KEY: "re_test", NEXT_PUBLIC_APP_URL: "https://hivra.test" };
  mockSend.mockReset().mockResolvedValue({ error: null });
});

afterAll(() => {
  process.env = originalEnv;
});

it("names both addresses, the unlock time and what to do if it wasn't the owner", async () => {
  const result = await sendWithdrawDestinationChangedEmail({
    userId: "user_1",
    kind: "agent_wallet",
    walletAddress: "0x000000000000000000000000000000000000ba5e",
    previousAddress: "0x1111111111111111111111111111111111111111",
    newAddress: "0x2222222222222222222222222222222222222222",
    changedAt,
    availableAt,
  });

  expect(result).toEqual({ sent: true });
  const [email, options] = mockSend.mock.calls[0] as [
    { to: string; subject: string; text: string },
    { idempotencyKey: string },
  ];
  expect(email.to).toBe("owner@example.com");
  expect(email.subject).toBe("An agent wallet's withdrawal destination changed");
  expect(email.text).toContain("agent wallet 0x000000000000000000000000000000000000ba5e");
  expect(email.text).toContain("New address: 0x2222222222222222222222222222222222222222");
  expect(email.text).toContain("Previous address: 0x1111111111111111111111111111111111111111");
  expect(email.text).toContain(`nothing can be sent to the new address for 24 hours`);
  expect(email.text).toContain(availableAt.toUTCString());
  expect(email.text).toContain("If you didn't");
  expect(email.text).toContain("https://hivra.test/dashboard/wallet");
  expect(options.idempotencyKey).toContain("withdraw-destination:user_1:agent_wallet:");
});

it("says 'none' for a first destination and sends nothing without an API key", async () => {
  await sendWithdrawDestinationChangedEmail({
    userId: "user_1",
    kind: "lock_wallet",
    previousAddress: null,
    newAddress: "0x2222222222222222222222222222222222222222",
    changedAt,
    availableAt,
  });
  const email = mockSend.mock.calls[0][0] as { subject: string; text: string };
  expect(email.subject).toBe("Your Hivra withdraw address changed");
  expect(email.text).toContain("Previous address: none");

  delete process.env.RESEND_API_KEY;
  mockSend.mockClear();
  const result = await sendWithdrawDestinationChangedEmail({
    userId: "user_1",
    kind: "lock_wallet",
    previousAddress: null,
    newAddress: "0x2222222222222222222222222222222222222222",
    changedAt,
    availableAt,
  });
  expect(result).toEqual({ sent: false, reason: "not_configured" });
  expect(mockSend).not.toHaveBeenCalled();
});
