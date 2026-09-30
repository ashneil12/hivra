/**
 * The waitlist invite's "Claim your spot" link. It used to open the plan page,
 * which defaults to Pro and starts checkout right after sign-up, for someone
 * who queued for Free. It now opens sign-up, which lands in Launch.
 */

const sendMock = jest.fn();

jest.mock("resend", () => ({
  Resend: jest.fn().mockImplementation(() => ({ emails: { send: sendMock } })),
}));

import { sendReservationInvite } from "@/lib/email/reservation-invite";
import { SITE_URL } from "@/lib/seo-urls";

describe("sendReservationInvite", () => {
  const env = process.env;

  beforeEach(() => {
    sendMock.mockReset().mockResolvedValue({ error: null });
    process.env = { ...env, RESEND_API_KEY: "re_test_key" };
  });

  afterAll(() => {
    process.env = env;
  });

  it("links Claim your spot to sign-up, never to the plan page", async () => {
    await expect(sendReservationInvite({ email: "person@example.com", claimToken: "tok 1" })).resolves.toEqual({ sent: true });

    const { text, html } = sendMock.mock.calls[0][0] as { text: string; html: string };
    expect(text).toContain(`Claim your spot → ${SITE_URL}/sign-up?invite=tok%201`);
    expect(html).toContain(`${SITE_URL}/sign-up?invite=tok%201`);
    expect(`${text}\n${html}`).not.toContain("/get-started");
  });
});
