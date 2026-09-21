/**
 * Reservation confirmation email.
 *
 * Sent immediately after a successful reservation insert in
 * POST /api/reserve. Best-effort and non-blocking — the API response is
 * not gated on email delivery. If RESEND_API_KEY is missing or the send
 * fails, we log and continue.
 *
 * Env:
 *   RESEND_API_KEY              required to actually send
 *   RESEND_FROM_EMAIL           "Display Name <addr@hermesos.cloud>" form
 *   RESERVATION_REPLY_TO_EMAIL  optional override for Reply-To
 */

import { Resend } from "resend";

import { SITE_URL } from "@/lib/seo-urls";

interface SendParams {
  email: string;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed";
  errorMessage?: string;
}

const SUBJECT = "You're on the Hivra waitlist";
const PLANS_URL = `${SITE_URL}/get-started`;
const TOKEN_URL = `${SITE_URL}/token`;

function buildText(): string {
  return [
    "You're on the Hivra waitlist.",
    "",
    "Hey,",
    "",
    "You're in. We'll send you an invite when Free plan access opens up — we're rolling out in waves to keep the platform fast as we scale.",
    "",
    "In the meantime, two things to know.",
    "",
    "— If you want to skip the wait",
    "Pro and Power tiers are available now.",
    "",
    "  Pro:   $9.99/mo card · $79/yr card · $49/yr in $HermesOS · or hold ~$99 worth to maintain access",
    "  Power: $19.99/mo card · $149/yr card · $99/yr in $HermesOS · or hold ~$199 worth",
    "",
    `See plans → ${PLANS_URL}`,
    "",
    "— For $HermesOS holders",
    "The launch rate for hold-to-access is only available for the first 30 days. After that, thresholds move up. If you're going to deposit, sooner is better.",
    "",
    `Token verification page → ${TOKEN_URL}`,
    "",
    "Otherwise, sit tight. We'll be in touch when capacity opens.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
}

function buildHtml(): string {
  const sansStack =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const monoStack = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const serifStack = "Georgia,'Times New Roman',serif";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${SUBJECT}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f1e8;font-family:${sansStack};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">You're in. Invites roll out in waves — here's how to skip the line.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
            <tr>
              <td style="padding:36px 36px 8px;">
                <p style="margin:0 0 18px;font-family:${monoStack};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">Waitlist</p>
                <h1 style="margin:0 0 20px;font-family:${serifStack};font-size:30px;line-height:1.15;font-weight:700;color:#1a1a1a;">You're in.</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">Hey,</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">We'll send you an invite when Free plan access opens up — we're rolling out in waves to keep the platform fast as we scale.</p>
                <p style="margin:0 0 28px;font-size:16px;line-height:1.6;color:#1a1a1a;">In the meantime, two things to know.</p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px;">
                <p style="margin:0 0 10px;font-family:${monoStack};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:700;">If you want to skip the wait</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">Pro and Power tiers are available now.</p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #ece7da;border-radius:4px;background:#faf7ee;">
                  <tr>
                    <td style="padding:16px 18px;border-bottom:1px solid #ece7da;">
                      <p style="margin:0 0 6px;font-family:${serifStack};font-size:17px;font-weight:700;color:#1a1a1a;">Pro</p>
                      <p style="margin:0;font-size:14px;line-height:1.6;color:#444;">$9.99/mo card &middot; $79/yr card &middot; $49/yr in $HermesOS &middot; or hold ~$99 worth to maintain access</p>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:16px 18px;">
                      <p style="margin:0 0 6px;font-family:${serifStack};font-size:17px;font-weight:700;color:#1a1a1a;">Power</p>
                      <p style="margin:0;font-size:14px;line-height:1.6;color:#444;">$19.99/mo card &middot; $149/yr card &middot; $99/yr in $HermesOS &middot; or hold ~$199 worth</p>
                    </td>
                  </tr>
                </table>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0 32px;">
                  <tr>
                    <td style="background:#1a1a1a;border-radius:4px;">
                      <a href="${PLANS_URL}" style="display:inline-block;padding:12px 22px;font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">See plans &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 10px;font-family:${monoStack};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:700;">For $HermesOS holders</p>
                <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#333;">The launch rate for hold-to-access is only available for the first 30 days. After that, thresholds move up. If you're going to deposit, sooner is better.</p>
                <p style="margin:0 0 28px;">
                  <a href="${TOKEN_URL}" style="font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#b3261e;text-decoration:none;font-weight:700;">Token verification page &rarr;</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">Otherwise, sit tight. We'll be in touch when capacity opens.</p>
                <p style="margin:0;font-size:15px;line-height:1.6;color:#1a1a1a;">— Ash<br /><span style="font-size:13px;color:#888;">Founder, Hivra</span></p>
              </td>
            </tr>
          </table>

          <p style="margin:18px 0 0;font-family:${monoStack};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9a9a9a;">hermesos.cloud</p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

export async function sendReservationConfirmation(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESERVATION_REPLY_TO_EMAIL ?? undefined;

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ReservationEmail] RESEND_API_KEY not configured; skipping confirmation for ${params.email}`
    );
    return { sent: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: params.email,
      ...(replyTo ? { replyTo } : {}),
      subject: SUBJECT,
      text: buildText(),
      html: buildHtml(),
    });

    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[ReservationEmail] Resend send failed for ${params.email}: ${error.message}`
      );
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[ReservationEmail] Resend threw for ${params.email}: ${msg}`);
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
