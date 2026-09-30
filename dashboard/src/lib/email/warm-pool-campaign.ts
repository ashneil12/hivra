/**
 * Warm-pool campaign email — Resend integration.
 *
 * ONE email, sent once, to the engaged-free pool (free plan + a running
 * instance + activity in the last 7 days) that has never been pitched Pro.
 * Owner-triggered via POST /api/admin/warm-pool-campaign; this module only
 * knows how to build and send the email. At-most-once bookkeeping lives in
 * lifecycle_email_sends under WARM_POOL_EMAIL_KEY (see the
 * warm-pool-campaign-sweep module).
 *
 * Voice: direct, minimal, dry. No exclamation points, no hype. Signed
 * "— Ash / Founder, Hivra" like the lifecycle emails.
 */

import { Resend } from "resend";

import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

/**
 * The lifecycle_email_sends ledger key for this campaign. Dated on purpose:
 * a future warm-pool campaign mints a new key instead of reusing this one.
 */
export const WARM_POOL_EMAIL_KEY = "warm_pool_2026_06";

export interface WarmPoolEmailContentParams {
  firstName?: string | null;
}

export interface WarmPoolEmailSendParams extends WarmPoolEmailContentParams {
  email: string;
  idempotencyKey: string;
}

export interface WarmPoolEmailContent {
  subject: string;
  text: string;
  html: string;
  ctaUrl: string;
}

export type WarmPoolEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const LOG_SOURCE = "warm-pool-campaign-email";
const CTA_URL = `${SITE_URL}/dashboard/billing?from=warm_pool`;

function greeting(firstName?: string | null): string {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

const PARAGRAPH_STYLE = "margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;";
const LIST_STYLE = "margin:0 0 20px;padding-left:20px;font-size:16px;line-height:1.6;color:#1a1a1a;";
const LIST_ITEM_STYLE = "margin:0 0 12px;";

function htmlParagraph(content: string): string {
  return `<p style="${PARAGRAPH_STYLE}">${content}</p>`;
}

function htmlList(items: string[]): string {
  const lis = items.map((item) => `<li style="${LIST_ITEM_STYLE}">${item}</li>`).join("");
  return `<ul style="${LIST_STYLE}">${lis}</ul>`;
}

/** Same shell as the other customer emails (see lifecycle.ts / cold-storage.ts). */
function shellHtml(opts: {
  preheader: string;
  eyebrow: string;
  title: string;
  body: string;
  ctaText: string;
  ctaUrl: string;
  footerNote?: string;
}): string {
  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const mono = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  const serif = "Georgia,'Times New Roman',serif";
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${opts.title}</title></head>
  <body style="margin:0;padding:0;background:#f5f1e8;font-family:${sans};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">${opts.preheader}</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr><td align="center" style="padding:40px 16px;">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
          <tr><td style="padding:36px 36px 24px;">
            <p style="margin:0 0 18px;font-family:${mono};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#b3261e;font-weight:700;">${opts.eyebrow}</p>
            <h1 style="margin:0 0 20px;font-family:${serif};font-size:28px;line-height:1.15;font-weight:700;color:#1a1a1a;">${opts.title}</h1>
            ${opts.body}
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:18px 0 8px;">
              <tr><td style="background:#1a1a1a;border-radius:4px;">
                <a href="${opts.ctaUrl}" style="display:inline-block;padding:14px 26px;font-family:${mono};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">${opts.ctaText} &rarr;</a>
              </td></tr>
            </table>
          </td></tr>
          ${opts.footerNote
            ? `<tr><td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
                <p style="margin:0;font-size:14px;line-height:1.6;color:#666;">${opts.footerNote}</p>
              </td></tr>`
            : ""}
        </table>
        <p style="margin:18px 0 0;font-family:${mono};font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#9a9a9a;">hermesos.cloud</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function buildWarmPoolEmail(params: WarmPoolEmailContentParams): WarmPoolEmailContent {
  const subject = "what your agent could be doing";
  const ctaUrl = CTA_URL;
  const capabilities = [
    `<strong>Web browsing.</strong> "Watch this product's price and tell me the day it drops." Free can't read live pages. Pro can.`,
    `<strong>Persistent memory.</strong> Tell it once that reports go in bullet points, numbers up top. It still knows in three weeks.`,
    `<strong>Scheduled tasks.</strong> "Every Monday at 9, give me the three things in my niche worth reading." Runs on its own, no prompt.`,
  ];
  const capabilitiesText = [
    `Web browsing. "Watch this product's price and tell me the day it drops." Free can't read live pages. Pro can.`,
    `Persistent memory. Tell it once that reports go in bullet points, numbers up top. It still knows in three weeks.`,
    `Scheduled tasks. "Every Monday at 9, give me the three things in my niche worth reading." Runs on its own, no prompt.`,
  ];
  const close = "If free covers you, ignore this — it stays free.";
  const text = [
    greeting(params.firstName),
    "",
    "You've had an agent running. Here's what changes on Pro:",
    "",
    ...capabilitiesText.map((c) => `  • ${c}`),
    "",
    "$9.99/mo, or $79/yr.",
    "",
    `Upgrade: ${ctaUrl}`,
    "",
    close,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Three things your agent picks up on Pro. $9.99/mo or $79/yr.",
    eyebrow: "Your agent",
    title: "What your agent could be doing.",
    body: [
      htmlParagraph(greeting(params.firstName)),
      htmlParagraph("You've had an agent running. Here's what changes on Pro:"),
      htmlList(capabilities),
      htmlParagraph("<strong>$9.99/mo, or $79/yr.</strong>"),
      htmlParagraph(close),
    ].join("\n"),
    ctaText: "See plans",
    ctaUrl,
    footerNote: "Reply to this email if anything's unclear. I read every reply. — Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

export async function sendWarmPoolEmail(
  params: WarmPoolEmailSendParams
): Promise<WarmPoolEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping warm-pool email", {
      source: LOG_SOURCE,
      to: params.email,
    });
    return { sent: false, reason: "not_configured" };
  }
  const from = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL ?? "info@hivra.cloud";
  const content = buildWarmPoolEmail(params);
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      {
        from,
        to: params.email,
        replyTo,
        subject: content.subject,
        text: content.text,
        html: content.html,
      },
      { idempotencyKey: params.idempotencyKey }
    );
    if (error) {
      log.warn("warm-pool email Resend send failed", {
        source: LOG_SOURCE,
        to: params.email,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("warm-pool email Resend threw", {
      source: LOG_SOURCE,
      to: params.email,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
