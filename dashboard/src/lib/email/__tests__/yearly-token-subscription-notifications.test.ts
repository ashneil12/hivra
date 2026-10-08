/** @jest-environment node */
/**
 * The renewal email must describe what a payment actually does: paying before
 * expiry extends the subscription from its current end (the settlement
 * function renews from max(expires_at, now)).
 *
 * It must also not send a holder in a country the token geo-policy lists to a
 * payment the server refuses (UKG-04). Those cases run against the COMMITTED
 * country list (never replacing the policy), with only the stored country and the
 * Clerk session country faked: if the list stopped reaching the email, they fail.
 */

// The committed list, not the empty one jest.setup.tsx gives other suites.
jest.mock("@/lib/compliance/token-geo-list", () => jest.requireActual("@/lib/compliance/token-geo-list"));

const mockSend = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: (...args: unknown[]) => mockSend(...args) } })),
}));

jest.mock("@clerk/nextjs/server", () => ({
  clerkClient: async () => ({
    users: { getUser: async () => ({ primaryEmailAddress: { emailAddress: "user@example.com" } }) },
  }),
}));

// The stored sign-up country the gate reads; a table name the test did not expect throws.
let storedCountry: string | null = null;
let storedCountryReadFails = false;
const mockFrom = jest.fn();
jest.mock("@/lib/supabase", () => ({
  get supabaseAdmin() {
    return { from: (table: string) => mockFrom(table) };
  },
}));

import { sendYearlyTokenSubscriptionNotification } from "@/lib/email/yearly-token-subscription-notifications";
import { TOKEN_GEO_POLICY } from "@/lib/compliance/token-geo-policy";

const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const clerkFetch = jest.fn();

beforeEach(() => {
  process.env = { ...originalEnv, RESEND_API_KEY: "re_test" };
  delete process.env.CLERK_SECRET_KEY;
  delete process.env.OPS_ADMIN_USER_IDS;
  delete process.env.OPS_ADMIN_EMAILS;
  storedCountry = null;
  storedCountryReadFails = false;
  mockSend.mockReset().mockResolvedValue({ error: null });
  clerkFetch.mockReset();
  global.fetch = clerkFetch as unknown as typeof fetch;
  mockFrom.mockReset().mockImplementation((table: string) => {
    if (table !== "signup_risk_assessments") throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            storedCountryReadFails
              ? { data: null, error: { code: "XX000", message: "boom" } }
              : { data: storedCountry ? { country_code: storedCountry } : null, error: null },
        }),
      }),
    };
  });
});

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
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
  // The link opens the $HermesOS payment for this tier directly (the billing
  // page's Active Plan view has no pay-with-token control of its own).
  expect(email.text).toMatch(/\/dashboard\/billing\?plan=pro&yearly_token=1/);
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

describe("a holder in a country the token geo-policy lists", () => {
  const expiring = {
    userId: "user_gb",
    tier: "pro" as const,
    transition: "expiring_soon" as const,
    expiresAt: new Date("2026-10-01T00:00:00Z"),
  };

  async function sentEmail(params: Parameters<typeof sendYearlyTokenSubscriptionNotification>[0]) {
    await expect(sendYearlyTokenSubscriptionNotification(params)).resolves.toEqual({ sent: true });
    return mockSend.mock.calls[0][0] as { to: string; subject: string; text: string };
  }

  it("is pointed at a card plan, with no $HermesOS renewal and no token payment link, before expiry", async () => {
    storedCountry = "GB";
    const email = await sentEmail(expiring);
    expect(email.subject).toBe("Your Hivra Pro subscription expires in 7 days");
    expect(email.text).not.toMatch(/yearly_token/);
    expect(email.text).not.toMatch(/pay for another year with \$HermesOS/);
    expect(email.text).not.toMatch(/Renew here/);
    expect(email.text).toMatch(/\/dashboard\/billing\?cadence=yearly/);
    expect(email.text).toMatch(/card plan/);
    // The facts about their account are unchanged.
    expect(email.text).toContain("expires on Thu, 01 Oct 2026 00:00:00 GMT");
    expect(email.text).toContain("7-day grace window");
  });

  it("is pointed at a card plan, with no $HermesOS renewal and no token payment link, after expiry", async () => {
    storedCountry = "GB";
    const email = await sentEmail({ ...expiring, tier: "power", transition: "expired" });
    expect(email.subject).toBe("Your Hivra Power subscription has ended");
    expect(email.text).not.toMatch(/yearly_token/);
    expect(email.text).not.toMatch(/pay with \$HermesOS again/);
    expect(email.text).toMatch(/\/dashboard\/billing\?cadence=yearly/);
    expect(email.text).toMatch(/card plan/);
    expect(email.text).toContain("moved back to the Free tier");
  });

  it("uses the country Clerk recorded for their latest session when no sign-up country is stored", async () => {
    process.env.CLERK_SECRET_KEY = "sk_test_geo";
    clerkFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => [{ latest_activity: { country: "United Kingdom" } }],
    });
    const email = await sentEmail(expiring);
    expect(email.text).not.toMatch(/yearly_token/);
    expect(email.text).toMatch(/card plan/);
  });

  it("still gets the token renewal email when their country is not listed", async () => {
    storedCountry = "US";
    const email = await sentEmail(expiring);
    expect(email.text).toMatch(/\/dashboard\/billing\?plan=pro&yearly_token=1/);
    expect(email.text).toMatch(/pay for another year with \$HermesOS/);
  });

  it("still gets the token renewal email when the country cannot be read, and the email is sent", async () => {
    storedCountryReadFails = true;
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const email = await sentEmail(expiring);
    expect(email.text).toMatch(/yearly_token=1/);
  });

  it("still gets the token renewal email when the database throws on the country read, and the email is sent", async () => {
    mockFrom.mockImplementation(() => {
      throw new Error("database down");
    });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const email = await sentEmail(expiring);
    expect(email.text).toMatch(/yearly_token=1/);
  });

  it("sends the ordinary email, never failing the cron's send, if the gate itself throws", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await jest.isolateModulesAsync(async () => {
      jest.doMock("@/lib/compliance/token-geo-gate", () => ({
        isNewTokenQualificationRefused: jest.fn().mockRejectedValue(new Error("gate down")),
      }));
      const { sendYearlyTokenSubscriptionNotification: send } = await import(
        "@/lib/email/yearly-token-subscription-notifications"
      );
      await expect(send(expiring)).resolves.toEqual({ sent: true });
    });
    jest.dontMock("@/lib/compliance/token-geo-gate");
    const email = mockSend.mock.calls[0][0] as { text: string };
    expect(email.text).toMatch(/yearly_token=1/);
  });

  it("keeps the token renewal email for an ops admin whose stored country is listed", async () => {
    storedCountry = "GB";
    process.env.OPS_ADMIN_USER_IDS = "user_gb";
    const email = await sentEmail(expiring);
    expect(email.text).toMatch(/yearly_token=1/);
  });

  it("reads no country at all while the policy lists none", async () => {
    jest.replaceProperty(TOKEN_GEO_POLICY, "blockedCountries", []);
    storedCountry = "GB";
    const email = await sentEmail(expiring);
    expect(email.text).toMatch(/yearly_token=1/);
    expect(mockFrom).not.toHaveBeenCalled();
    expect(clerkFetch).not.toHaveBeenCalled();
  });
});
