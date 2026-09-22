/** @jest-environment node */
/**
 * The renewal email must describe what a payment actually does: paying before
 * expiry extends the subscription from its current end (the settlement
 * function renews from max(expires_at, now)).
 */

const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } })),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUser: async () => ({ primaryEmailAddress: { emailAddress: "user@example.com" } }) },
  }),
}));

import { sendYearlyTokenSubscriptionNotification } from "@/lib/email/yearly-token-subscription-notifications";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...originalEnv, RESEND_API_KEY: "re_test" };
  mockSend.mockReset().mockResolvedValue({ error: null });
});

afterAll(() => {
  process.env = originalEnv;
});

it("tells the user a renewal before expiry adds a year on top of the current end date", async () => {
  const result = await sendYearlyTokenSubscriptionNotification({
    userId: "user_1",
    tier: "pro",
    transition: "expiring_soon",
    expiresAt: new Date("2026-10-01T00:00:00Z"),
  });

  expect(result).toEqual({ sent: true });
  const email = mockSend.mock.calls[0][0] as { to: string; subject: string; text: string };
  expect(email.to).toBe("user@example.com");
  expect(email.subject).toBe("Your Hivra Pro subscription expires in 7 days");
  expect(email.text).toContain("adds a full year on top of your current end date");
  expect(email.text).toContain("a payment made then runs for a year from the day you pay");
  expect(email.text).not.toContain("mint a fresh quote");
});

it("reports not_configured without sending when Resend is not set up", async () => {
  delete process.env.RESEND_API_KEY;
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  const result = await sendYearlyTokenSubscriptionNotification({
    userId: "user_1",
    tier: "power",
    transition: "expired",
    expiresAt: new Date("2026-10-01T00:00:00Z"),
  });

  expect(result).toEqual({ sent: false, reason: "not_configured" });
  expect(mockSend).not.toHaveBeenCalled();
  warn.mockRestore();
});
