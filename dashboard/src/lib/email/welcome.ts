/**
 * Welcome email — sent when a Clerk account is created.
 *
 * Fires from the Clerk webhook on `user.created`. Best-effort: failures
 * are logged and swallowed so the webhook can still acknowledge to Clerk
 * (a 200 prevents Clerk from retrying and double-sending).
 */

import { Resend } from "resend";

import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface SendParams {
  email: string;
  firstName?: string | null;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed" | "internal_recipient";
  errorMessage?: string;
}

// Recipients that can never receive mail: the first-run audit harness signs up
// synthetic Clerk users as firstrun-audit-<hex>@hermesos.cloud, and both
// hermesos.cloud and hivra.cloud have receiving disabled in Resend. Every send
// to them hard-bounces (42/100 on 2026-07-09), which poisons sender reputation
// and risks Resend account review — so suppress before hitting the API.
const INTERNAL_LOCAL_PART_PREFIXES = ["firstrun-audit-"];
const NON_RECEIVING_DOMAINS = ["hermesos.cloud", "hivra.cloud"];

export function isInternalNonReceivingRecipient(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  if (INTERNAL_LOCAL_PART_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return true;
  }
  return NON_RECEIVING_DOMAINS.some((domain) => normalized.endsWith(`@${domain}`));
}

const SUBJECT = "Welcome to Hivra";
const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const ROADMAP_URL = `${SITE_URL}/roadmap`;

function greeting(firstName?: string | null) {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

function buildText(params: SendParams): string {
  return [
    "Welcome to Hivra.",
    "",
    greeting(params.firstName),
    "",
    "Your account is live. Two minutes from now you can have a persistent agent running with no Docker, no VPS, no babysitting.",
    "",
    `Open the dashboard → ${DASHBOARD_URL}`,
    "",
    "What's worth doing first:",
    "  • Pick a profile and deploy your first agent",
    "  • Add the integrations your agent needs (chat, browser, etc.)",
    "  • Free tier access is included; anti-abuse checks may apply for provisioning",
    "",
    `Curious where we're headed: ${ROADMAP_URL}`,
    "",
    "Reply to this email if anything's unclear. I read every reply.",
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
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Your account is live. Deploy your first agent in two minutes.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
            <tr>
              <td style="padding:36px 36px 8px;">
                <p style="margin:0 0 18px;font-family:${monoStack};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">Welcome</p>
                <h1 style="margin:0 0 20px;font-family:${serifStack};font-size:30px;line-height:1.15;font-weight:700;color:#1a1a1a;">You're set up.</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
                <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Your account is live. Two minutes from now you can have a persistent agent running with no Docker, no VPS, no babysitting.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px;">
                  <tr>
                    <td style="background:#1a1a1a;border-radius:4px;">
                      <a href="${DASHBOARD_URL}" style="display:inline-block;padding:14px 26px;font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">Open the dashboard &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 12px;font-family:${monoStack};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:#888;font-weight:700;">What's worth doing first</p>
                <ul style="margin:0 0 24px;padding:0 0 0 18px;font-size:15px;line-height:1.65;color:#333;">
                  <li>Pick a profile and deploy your first agent</li>
                  <li>Add the integrations your agent needs (chat, browser, and more)</li>
                  <li>Free tier access is included; anti-abuse checks may apply for provisioning</li>
                </ul>
                <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#666;">
                  Curious where we're headed:
                  <a href="${ROADMAP_URL}" style="color:#b3261e;text-decoration:none;font-weight:700;">roadmap &rarr;</a>
                </p>
              </td>
            </tr>

            <tr>
              <td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">Reply to this email if anything's unclear. I read every reply.</p>
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

export async function sendWelcomeEmail(params: SendParams): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESERVATION_REPLY_TO_EMAIL ?? undefined;

  if (isInternalNonReceivingRecipient(params.email)) {
    log.info("welcome email suppressed for internal non-receiving recipient", {
      source: "welcome-email",
      failureType: "welcome_email_internal_recipient",
      email: params.email,
    });
    return { sent: false, reason: "internal_recipient" };
  }

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[WelcomeEmail] RESEND_API_KEY not configured; skipping welcome for ${params.email}`
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
      // log.warn (not error) — a failed welcome email shouldn't fire ops_event
      // alerts (the user account is fine; this is a downstream comms issue).
      // The structured fields make Resend rejections (domain unverified,
      // bounced recipient, rate limit, etc.) filterable in Vercel logs.
      log.warn("welcome email Resend send failed", {
        source: "welcome-email",
        failureType: "resend_send_failed",
        email: params.email,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("welcome email Resend threw", {
      source: "welcome-email",
      failureType: "resend_send_threw",
      email: params.email,
      errorName: err instanceof Error ? err.name : typeof err,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
