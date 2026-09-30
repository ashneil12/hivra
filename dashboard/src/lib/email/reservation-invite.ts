/**
 * Reservation invite email.
 *
 * Sent when a queued reservation is flipped to "invited" by the
 * `dashboard/scripts/send-reservation-invites.ts` admin script. The
 * helper itself is deliberately just the email — the caller decides
 * when to send and is responsible for the status flip.
 *
 * Best-effort: failures are returned in the result object, never thrown.
 */

import { Resend } from "resend";

import { PUBLIC_START_HREF } from "@/lib/public-start";
import { SITE_URL } from "@/lib/seo-urls";

interface SendParams {
  email: string;
  firstName?: string | null;
  /** Per-invite claim token; appended as ?invite=<token> for onboard tracking. */
  claimToken?: string | null;
  /** Hours the invite stays claimable before the slot passes to the next person. */
  claimWindowHours?: number | null;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed";
  errorMessage?: string;
}

const SUBJECT = "Your Hivra access is ready";
// Sign-up lands in Launch, which offers Free with its own button. The plan
// page would start Pro checkout for someone who queued for Free.
const SIGN_UP_URL = `${SITE_URL}${PUBLIC_START_HREF}`;

function claimUrl(token?: string | null): string {
  return token ? `${SIGN_UP_URL}?invite=${encodeURIComponent(token)}` : SIGN_UP_URL;
}

function claimWindowLine(hours?: number | null): string | null {
  if (!hours || hours <= 0) return null;
  return `Heads up: your spot is held for ${hours} hours — claim it before then or it passes to the next person in line.`;
}

function greeting(firstName?: string | null) {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

function buildText(params: SendParams): string {
  return [
    "Your Hivra access is ready.",
    "",
    greeting(params.firstName),
    "",
    "Capacity opened up. You can deploy Codex, Claude Code, or Hermes right now.",
    "",
    `Claim your spot → ${claimUrl(params.claimToken)}`,
    ...(claimWindowLine(params.claimWindowHours) ? ["", claimWindowLine(params.claimWindowHours) as string] : []),
    "",
    "What you can do once you're in:",
    "  • Codex, Claude Code, Hermes, and Aeon, all live now. Pick one and it's running in five minutes (no Docker, no VPS)",
    "  • Free tier access is included; anti-abuse checks may apply for provisioning",
    "  • Pro and Power available if you want more compute headroom",
    "",
    "Reply if you hit any snags during setup.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
}

function buildHtml(params: SendParams): string {
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
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Codex, Claude Code, Hermes, and Aeon are live. Claim your Hivra spot.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
            <tr>
              <td style="padding:36px 36px 8px;">
                <p style="margin:0 0 18px;font-family:${monoStack};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">Invite</p>
                <h1 style="margin:0 0 20px;font-family:${serifStack};font-size:30px;line-height:1.15;font-weight:700;color:#1a1a1a;">You're cleared in.</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">Capacity opened up. You can deploy Codex, Claude Code, or Hermes right now.</p>
                ${claimWindowLine(params.claimWindowHours) ? `<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#b3261e;">${claimWindowLine(params.claimWindowHours)}</p>` : ""}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;">
                  <tr>
                    <td style="background:#1a1a1a;border-radius:4px;">
                      <a href="${claimUrl(params.claimToken)}" style="display:inline-block;padding:14px 26px;font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">Claim your spot &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 12px;font-family:${monoStack};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:700;">What you can do once you're in</p>
                <ul style="margin:0 0 24px;padding:0 0 0 18px;font-size:15px;line-height:1.65;color:#333;">
                  <li>Codex, Claude Code, Hermes, and Aeon, all live now. Pick one and it's running in five minutes (no Docker, no VPS)</li>
                  <li>Free tier access is included; anti-abuse checks may apply for provisioning</li>
                  <li>Pro and Power available if you want more compute headroom</li>
                </ul>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">Reply if you hit any snags during setup.</p>
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

export async function sendReservationInvite(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESERVATION_REPLY_TO_EMAIL ?? undefined;

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[ReservationInvite] RESEND_API_KEY not configured; skipping invite for ${params.email}`
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
      text: buildText(params),
      html: buildHtml(params),
    });

    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[ReservationInvite] Resend send failed for ${params.email}: ${error.message}`
      );
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[ReservationInvite] Resend threw for ${params.email}: ${msg}`);
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
