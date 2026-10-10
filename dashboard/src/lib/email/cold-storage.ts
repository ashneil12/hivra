/**
 * Cold-storage lifecycle emails — Resend integration.
 *
 * Three customer-facing emails, sent by the cold-storage-notifications cron
 * and (in one case) by the restore handler. See
 * docs/cold-storage-orchestration.md §6.
 */

import { Resend } from "resend";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface BaseSendParams {
  email: string;
  firstName?: string | null;
  agentName?: string | null;
  /** Catalog agent type (hermes_instances.agent_type) — resolves the display name. */
  agentType?: string | null;
  idempotencyKey: string;
}

export type ColdStorageEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const DASHBOARD_URL = `${SITE_URL}/dashboard`;
const BILLING_URL = `${SITE_URL}/dashboard/billing`;
const LOG_SOURCE = "cold-storage-email";

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
}): Promise<ColdStorageEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping cold-storage email", {
      source: LOG_SOURCE,
      to: opts.to,
      notification: opts.notificationName,
    });
    return { sent: false, reason: "not_configured" };
  }
  const from = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";
  const replyTo = process.env.RESEND_REPLY_TO_EMAIL ?? "info@hivra.cloud";
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      { from, to: opts.to, replyTo, subject: opts.subject, text: opts.text, html: opts.html },
      { idempotencyKey: opts.idempotencyKey }
    );
    if (error) {
      log.warn("cold-storage email Resend send failed", {
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
    log.warn("cold-storage email Resend threw", {
      source: LOG_SOURCE,
      to: opts.to,
      notification: opts.notificationName,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}

export async function sendColdArchivedEmail(
  params: BaseSendParams
): Promise<ColdStorageEmailSendResult> {
  const subject = `We've paused ${agentLabel(params.agentName, params.agentType)}`;
  const text = [
    `We've paused ${agentLabel(params.agentName, params.agentType)} and moved it to cold storage.`,
    "",
    greeting(params.firstName),
    "",
    `Since ${agentLabel(params.agentName, params.agentType)} has been inactive for a while, we've moved its state to cold storage to free up resources. Your data is safe and intact.`,
    "",
    "When you're ready to use it again, hit Start in your dashboard:",
    DASHBOARD_URL,
    "",
    "Restoring takes about 5 minutes the first time — chat history and settings come back intact.",
    "",
    `Want it to never pause? Pro agents stay always-on — they're never put to sleep for inactivity. ${BILLING_URL}`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "Your agent is paused in cold storage — restore it any time.",
    eyebrow: "Paused",
    title: "We've paused your agent.",
    body: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Since ${agentLabel(params.agentName, params.agentType)} has been inactive, we've moved its state to cold storage to free up resources. Your data is safe and intact.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">When you're ready, hit Start. Restoring takes about 5 minutes the first time — chat history and settings come back intact.</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#666;">Want it to never pause? <a href="${BILLING_URL}" style="color:#1a1a1a;text-decoration:underline;">Pro agents stay always-on</a> — never put to sleep for inactivity.</p>
    `,
    ctaText: "Open the dashboard",
    ctaUrl: DASHBOARD_URL,
    footerNote: "Reply to this email if anything's unclear. I read every reply. — Ash",
  });
  return send({
    to: params.email,
    subject,
    text,
    html,
    idempotencyKey: params.idempotencyKey,
    notificationName: "cold_archived",
  });
}

export async function sendColdPendingDeletionEmail(
  params: BaseSendParams & { daysUntilDeletion: number; scheduledDeletionDateIso: string }
): Promise<ColdStorageEmailSendResult> {
  const days = Math.max(1, params.daysUntilDeletion);
  const dateLabel = params.scheduledDeletionDateIso.slice(0, 10);
  const subject =
    days <= 2
      ? `Final notice: ${agentLabel(params.agentName, params.agentType)} will be deleted in ${days} day${days === 1 ? "" : "s"}`
      : `Your agent will be deleted in ${days} days — last chance`;
  const text = [
    `${greeting(params.firstName)}`,
    "",
    `${agentLabel(params.agentName, params.agentType)} has been in cold storage and hasn't been used recently. We'll permanently delete it on ${dateLabel} unless you reactivate.`,
    "",
    `Bring it back by clicking Start in your dashboard:`,
    DASHBOARD_URL,
    "",
    `If you no longer need this agent, no action is required — it'll be removed automatically.`,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: `${agentLabel(params.agentName, params.agentType)} will be deleted on ${dateLabel}.`,
    eyebrow: days <= 2 ? "Final notice" : "Action required",
    title:
      days <= 2
        ? `${days} day${days === 1 ? "" : "s"} left to keep your agent.`
        : `Your agent will be deleted in ${days} days.`,
    body: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">${agentLabel(params.agentName, params.agentType)} has been in cold storage and hasn't been used recently. We'll permanently delete it on <strong>${dateLabel}</strong> unless you reactivate.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Restoring takes about 5 minutes — chat history and settings come back intact.</p>
    `,
    ctaText: "Restore my agent",
    ctaUrl: DASHBOARD_URL,
    footerNote: "If you no longer need this agent, no action is required — it'll be removed automatically.",
  });
  return send({
    to: params.email,
    subject,
    text,
    html,
    idempotencyKey: params.idempotencyKey,
    notificationName: days <= 2 ? "cold_final_notice" : "cold_pending_deletion",
  });
}

export async function sendColdDeletedEmail(
  params: BaseSendParams
): Promise<ColdStorageEmailSendResult> {
  const subject = `${agentLabel(params.agentName, params.agentType)} has been deleted`;
  const text = [
    `${greeting(params.firstName)}`,
    "",
    `${agentLabel(params.agentName, params.agentType)} has been permanently deleted from Hivra, as previously notified.`,
    "",
    `If you'd like a fresh start, you can create a new agent any time:`,
    DASHBOARD_URL,
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: `${agentLabel(params.agentName, params.agentType)} has been permanently deleted.`,
    eyebrow: "Deleted",
    title: "Your agent has been deleted.",
    body: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">${agentLabel(params.agentName, params.agentType)} has been permanently deleted from Hivra, as previously notified.</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">If you'd like a fresh start, you can create a new agent any time.</p>
    `,
    ctaText: "Create a new agent",
    ctaUrl: DASHBOARD_URL,
  });
  return send({
    to: params.email,
    subject,
    text,
    html,
    idempotencyKey: params.idempotencyKey,
    notificationName: "cold_deleted",
  });
}
