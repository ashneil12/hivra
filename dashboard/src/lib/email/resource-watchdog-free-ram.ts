/**
 * Free-tier RAM-cap pause email — Resend integration.
 *
 * Sent by the resource-watchdog cron right after it pauses a free agent that
 * pinned its recorded RAM cap (`paused_reason='ram_cap_hit'`). Use the actual
 * allocation, not a fixed tier size: support exceptions may differ. This is
 * a monitoring safeguard, not evidence of an OOM crash or a usage-time limit.
 * Email reaches owners using Telegram/Discord who may not see the banner.
 *
 * So this email does one job: say plainly what happened, how to start the
 * agent again, and what the fix is if they want to keep working at that size.
 *
 * Idempotency: the caller passes "watchdog-ram/${instanceId}/${YYYY-MM-DD}".
 * The ram_cap_hit flag is auto-resolved on insert (a re-pinned box gets paused
 * again, by design), so the day-scoped key is what stops a user who keeps
 * pushing from getting the same mail every 15 minutes.
 */

import { Resend } from "resend";

import { escapeHtml } from "@/lib/email/escape-html";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";
import { MEMORY_PAUSE_TITLE } from "@/lib/memory-pause-message";

interface SendParams {
  email: string;
  agentName: string;
  /** Mean RAM usage across the window, as a fraction of the cap (0-1+). */
  avgRamPct: number;
  ramLimitMb: number;
  windowMinutes: number;
  idempotencyKey: string;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "send_failed";
  errorMessage?: string;
}

const SUBJECT = MEMORY_PAUSE_TITLE;
const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const BILLING_URL = `${SITE_URL}/dashboard/billing`;
const LOG_SOURCE = "resource-watchdog-free-ram";

function formatPct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatGb(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return Number.isInteger(gb) ? `${gb} GB` : `${gb.toFixed(1)} GB`;
  }
  return `${mb} MB`;
}

export function buildText(params: SendParams): string {
  return [
    "Your agent was paused for high memory use.",
    "",
    "Hey,",
    "",
    `Recent monitoring showed your agent (${params.agentName}) using ${formatPct(
      params.avgRamPct
    )} of its ${formatGb(params.ramLimitMb)} memory allocation, so the platform paused it. This is a memory safeguard, not a usage-time limit or confirmation of an out-of-memory crash.`,
    "",
    `Stopping the agent does not delete its stored files, but unsaved work may be interrupted. Review the workload before starting it again from the dashboard. ${DASHBOARD_URL}`,
    "",
    `If memory use stays high, it may pause again. Reduce the workload or review the resources available on your plan. If the reported allocation looks wrong, contact support before changing your plan. ${BILLING_URL}`,
    "",
    "Reply if you're not sure which one you need and I'll take a look at what your agent is doing.",
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

  const safeAgent = escapeHtml(params.agentName);
  const safeRam = escapeHtml(formatPct(params.avgRamPct));
  const safeLimit = escapeHtml(formatGb(params.ramLimitMb));

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${SUBJECT}</title>
  </head>
  <body style="margin:0;padding:0;background:#f5f1e8;font-family:${sansStack};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <span style="display:none !important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">Review memory use and allocated resources before restarting.</span>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f1e8;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid #e7e2d6;border-radius:6px;">
            <tr>
              <td style="padding:36px 36px 8px;">
                <p style="margin:0 0 18px;font-family:${monoStack};font-size:11px;letter-spacing:0.16em;text-transform:uppercase;color:#92400e;font-weight:700;">High memory use</p>
                <h1 style="margin:0 0 20px;font-family:${serifStack};font-size:30px;line-height:1.15;font-weight:700;color:#1a1a1a;">Your agent was paused for high memory use.</h1>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">Hey,</p>
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">Recent monitoring showed your agent (<strong>${safeAgent}</strong>) using <strong>${safeRam}</strong> of its <strong>${safeLimit}</strong> memory allocation, so the platform paused it. This is a memory safeguard, not a usage-time limit or confirmation of an out-of-memory crash.</p>
                <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Stopping the agent does not delete its stored files, but unsaved work may be interrupted. Review the workload before starting it again from the dashboard.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 24px;">
                  <tr>
                    <td style="background:#1a1a1a;border-radius:4px;">
                      <a href="${DASHBOARD_URL}" style="display:inline-block;padding:14px 26px;font-family:${monoStack};font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:#ffffff;text-decoration:none;font-weight:700;">Start it again &rarr;</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 36px 36px;border-top:1px solid #ece7da;">
                <div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">If memory use stays high, it may pause again. Reduce the workload or <a href="${BILLING_URL}" style="color:#1a1a1a;font-weight:600;">review the resources available on your plan</a>. If the reported allocation looks wrong, contact support before changing your plan.</p>
                <p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#444;">Reply if you're not sure which one you need and I'll take a look at what your agent is doing.</p>
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

export const RESOURCE_WATCHDOG_FREE_RAM_SUBJECT = SUBJECT;

export async function sendFreeRamPressureEmail(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL ?? "info@hivra.cloud";

  if (!apiKey) {
    return { sent: false, reason: "not_configured" };
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      {
        from: fromAddress,
        to: params.email,
        replyTo,
        subject: SUBJECT,
        text: buildText(params),
        html: buildHtml(params),
      },
      { idempotencyKey: params.idempotencyKey }
    );

    if (error) {
      log.warn("free-ram pressure email send failed", {
        source: LOG_SOURCE,
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
    log.warn("free-ram pressure email threw", {
      source: LOG_SOURCE,
      failureType: "resend_send_threw",
      email: params.email,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
