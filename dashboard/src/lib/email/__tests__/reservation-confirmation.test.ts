/**
 * The waitlist confirmation goes to whatever address a stranger types into the
 * public POST /api/reserve, from any country, so it carries no token wording at
 * all: no token price, no hold-to-qualify amount, no deadline, no token link.
 * The card plans and their prices stay, read from the plan table.
 */
const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { sendReservationConfirmation } from "@/lib/email/reservation-confirmation";
import { SITE_URL } from "@/lib/seo-urls";
import { PLANS } from "@/lib/subscription/plans";

// The email writes a whole-dollar yearly price without cents ($79/yr), a monthly one with them ($9.99/mo).
const dollars = (cents: number) => (cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`);

// Token words, plus the lines the old email used to pressure a holder.
const TOKEN_OR_PRESSURE =
  /\$HermesOS|\$HIVRA|\btokens?\b|\bBankr\b|wallets?|\bhold\b|hold-to-access|deposit|thresholds?|launch rate|first 30 days|sooner is better|only available/i;

describe("sendReservationConfirmation", () => {
  const env = process.env;

  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ error: null });
    process.env = { ...env, RESEND_API_KEY: "re_test_key" };
  });

  afterAll(() => {
    process.env = env;
  });

  async function sentEmail() {
    await expect(sendReservationConfirmation({ email: "person@example.com" })).resolves.toEqual({ sent: true });
    return sendMock.mock.calls[0][0] as { to: string; subject: string; text: string; html: string };
  }

  it("has no token price, hold amount, deadline or token link, in the text or the HTML", async () => {
    const { text, html } = await sentEmail();
    expect(text).not.toMatch(TOKEN_OR_PRESSURE);
    expect(html).not.toMatch(TOKEN_OR_PRESSURE);
    expect(`${text}\n${html}`).not.toContain("/token");
    expect(`${text}\n${html}`).not.toMatch(/\$49\/yr|\$99\/yr|~\$99|~\$199/);
  });

  it("still lists the card plans at the prices in the plan table, and links to the plans", async () => {
    const { text, html } = await sentEmail();
    const { operator, fleet } = PLANS;
    for (const line of [
      `${dollars(operator.price)}/mo card`,
      `${dollars(operator.yearlyPrice)}/yr card`,
      `${dollars(fleet.price)}/mo card`,
      `${dollars(fleet.yearlyPrice)}/yr card`,
    ]) {
      expect(text).toContain(line);
      expect(html).toContain(line);
    }
    expect(text).toContain(`See plans → ${SITE_URL}/get-started`);
    expect(html).toContain(`${SITE_URL}/get-started`);
  });

  it("has no em or en dash, and counts its own asides: one thing to know", async () => {
    const { text, html, subject } = await sentEmail();
    expect(`${subject}\n${text}\n${html}`).not.toMatch(/[–—]/);
    expect(text).toContain("In the meantime, one thing to know.");
    expect(html).toContain("In the meantime, one thing to know.");
    expect(`${text}\n${html}`).not.toContain("two things to know");
  });

  it("sends to the address it was given, and skips the send when Resend is not configured", async () => {
    const sent = await sentEmail();
    expect(sent.to).toBe("person@example.com");
    expect(sent.subject).toBe("You're on the Hivra waitlist");

    sendMock.mockClear();
    delete process.env.RESEND_API_KEY;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(sendReservationConfirmation({ email: "person@example.com" })).resolves.toEqual({
      sent: false,
      reason: "not_configured",
    });
    expect(sendMock).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
