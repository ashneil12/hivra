import { Resend } from "resend";
import { escapeHtml } from "@/lib/email/escape-html";

import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface SendParams {
  email: string;
  firstName?: string | null;
  /** YYYY-MM-DD UTC date for the deletion. */
  deletionDate: string;
  /** Approx hours remaining for body copy. Typically 24. */
  hoursRemaining: number;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed";
  errorMessage?: string;
  resendId?: string;
}

const SUBJECT = "Last chance — your Hivra agent gets deleted tomorrow";
const DASHBOARD_URL = `${SITE_URL}/dashboard`;

function greeting(firstName?: string | null) {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

export function buildText(params: SendParams): string {
  return [
    "Final reminder before deletion.",
    "",
    greeting(params.firstName),
    "",
    `Quick heads-up — your Hivra agent will be permanently deleted in roughly ${params.hoursRemaining} hours, on ${params.deletionDate}. This is the last reminder.`,
    "",
    "If you want to keep it, log in and resume any time before then. That cancels the deletion.",
    "",
    `Open the dashboard → ${DASHBOARD_URL}`,
    "",
    "If not, no action needed — the agent and its VM will be removed.",
    "",
    "Reply if you have questions.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
}

export function buildHtml(params: SendParams): string {
  const sansStack =
    "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const monoStack = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const serifStack = "Georgia,'Times New Roman',serif";

  const safeGreeting = escapeHtml(greeting(params.firstName));
  const safeDate = escapeHtml(params.deletionDate);
  const safeHours = String(params.hoursRemaining);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${SUBJECT}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f1e8;font-family:${sansStack};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Final reminder — your idle agent gets deleted tomorrow.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
            <tr>
              <td style="padding:36px 36px 8px;">
                <p style="margin:0 0 18px;font-family:${monoStack};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">Final reminder</p>
                <h1 style="margin:0 0 20px;font-family:${serifStack};font-size:30px;line-height:1.15;font-weight:700;color:#1a1a1a;">Your agent gets deleted tomorrow.</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${safeGreeting}</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">Quick heads-up — your Hivra agent will be permanently deleted in roughly <strong>${safeHours} hours</strong>, on <strong>${safeDate}</strong>. This is the last reminder.</p>
                <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">If you want to keep it, log in and resume any time before then. That cancels the deletion automatically.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px;">
                  <tr>
                    <td style="background:#1a1a1a;border-radius:4px;">
                      <a href="${DASHBOARD_URL}" style="display:inline-block;padding:14px 26px;font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">Open the dashboard &rarr;</a>
                    </td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#444;">If not, no action needed — the agent and its VM will be removed at the time above.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">Reply to this email if you have questions — I read every reply.</p>
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

export async function sendAgentDeletionFinalReminderEmail(
  params: SendParams & { idempotencyKey: string },
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL ?? "info@hermesos.cloud";

  if (!apiKey) {
    return { sent: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      {
        from: fromAddress,
        to: params.email,
        replyTo,
        subject: SUBJECT,
        text: buildText(params),
        html: buildHtml(params),
      },
      { idempotencyKey: params.idempotencyKey },
    );

    if (error) {
      log.warn("agent-deletion-final-reminder email Resend send failed", {
        source: "agent-deletion-final-reminder",
        failureType: "resend_send_failed",
        email: params.email,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true, resendId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("agent-deletion-final-reminder email Resend threw", {
      source: "agent-deletion-final-reminder",
      failureType: "resend_send_threw",
      email: params.email,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
