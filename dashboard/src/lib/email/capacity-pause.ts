/**
 * Capacity-pressure pause email — Resend integration.
 *
 * One customer-facing email, sent by the capacity-pressure-sweep cron right
 * after it parks an idle agent on an over-capacity host. Mirrors the
 * structure of src/lib/email/cold-storage.ts (same shell, same send
 * mechanics, same idempotency contract).
 *
 * Idempotency: the cron passes "${instanceId}:capacity_paused:${pausedAt}"
 * as the Resend idempotencyKey and records the send in the row's
 * notifications_sent JSONB — double-trigger safe even if the marker write
 * is lost.
 */

import { Resend } from "resend";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface CapacityPausedEmailParams {
  email: string;
  firstName?: string | null;
  agentName?: string | null;
  /** Catalog agent type (hermes_instances.agent_type) — resolves the display name. */
  agentType?: string | null;
  idempotencyKey: string;
}

export type CapacityPauseEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const LOG_SOURCE = "capacity-pause-email";

function greeting(firstName?: string | null): string {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

// "your agent \"Name\"" when the user named it; otherwise the catalog display
// name for the deployed agent type ("your Claude Code agent"), falling back to
// a neutral "your agent" when the type can't be resolved. Never hardcodes a
// specific agent — a Codex/Aeon/Claude Code box must not read as "Hermes".
function agentLabel(agentName?: string | null, agentType?: string | null): string {
  if (agentName?.trim()) return `your agent "${agentName.trim()}"`;
  const typeName = agentType ? getAgent(agentType)?.name : undefined;
  return typeName ? `your ${typeName} agent` : "your agent";
}

// Same label, capitalized for use at the start of a subject/sentence.
function agentLabelCapitalized(agentName?: string | null, agentType?: string | null): string {
  const label = agentLabel(agentName, agentType);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

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

async function send(opts: {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey: string;
  notificationName: string;
}): Promise<CapacityPauseEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping capacity-pause email", {
      source: LOG_SOURCE,
      to: opts.to,
      notification: opts.notificationName,
    });
    return { sent: false, reason: "not_configured" };
  }
  const from = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL ?? "info@hermesos.cloud";
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      { from, to: opts.to, replyTo, subject: opts.subject, text: opts.text, html: opts.html },
      { idempotencyKey: opts.idempotencyKey }
    );
    if (error) {
      log.warn("capacity-pause email Resend send failed", {
        source: LOG_SOURCE,
        to: opts.to,
        notification: opts.notificationName,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("capacity-pause email Resend threw", {
      source: LOG_SOURCE,
      to: opts.to,
      notification: opts.notificationName,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}

export async function sendCapacityPausedEmail(
  params: CapacityPausedEmailParams
): Promise<CapacityPauseEmailSendResult> {
  const subject = `${agentLabelCapitalized(params.agentName, params.agentType)} is taking a nap \u{1F634} — wake it anytime`;
  const text = [
    greeting(params.firstName),
    "",
    `${agentLabel(params.agentName, params.agentType)} hadn't been used in a while, and the platform is running close to capacity right now — so we tucked it in for a nap to keep things fast and healthy for everyone.`,
    "",
    "Nothing is lost. Your data, chat history, and settings are exactly where you left them.",
    "",
    "Waking it up takes one click — hit Start in your dashboard:",
    DASHBOARD_URL,
    "",
    "If it keeps napping for another 48 hours, we'll archive it safely to cold storage to free up the hardware — still fully restorable, any time.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Your agent is napping to keep the platform healthy — wake it with one click.",
    eyebrow: "Taking a nap",
    title: "Your agent is taking a nap.",
    body: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">${agentLabel(params.agentName, params.agentType)} hadn't been used in a while, and the platform is running close to capacity right now — so we tucked it in for a nap to keep things fast and healthy for everyone.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Nothing is lost. Your data, chat history, and settings are exactly where you left them — hitting Start wakes it right back up.</p>
    `,
    ctaText: "Wake it up",
    ctaUrl: DASHBOARD_URL,
    footerNote:
      "If it keeps napping for another 48 hours, we'll archive it safely to cold storage — still fully restorable any time. Reply to this email if anything's unclear. — Ash",
  });
  return send({
    to: params.email,
    subject,
    text,
    html,
    idempotencyKey: params.idempotencyKey,
    notificationName: "capacity_paused",
  });
}
