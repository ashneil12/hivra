/**
 * "Your agent needs your approval" email — Resend integration.
 *
 * Sent by the expire-pending-prompts cron when an agent has been blocked on a
 * dangerous-command approval for longer than the nudge threshold and the owner
 * hasn't answered in the workspace iframe. Mirrors src/lib/email/capacity-pause.ts
 * (same shell, same send mechanics, same idempotency contract).
 *
 * Idempotency: the cron passes "pending-prompt:${rowId}" as the Resend
 * idempotencyKey and stamps notified_at on the row after the send — one email
 * per prompt even if the marker write is lost.
 */

import { Resend } from "resend";

import { getAgent } from "@/lib/hivra/agent-catalog";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

interface AgentApprovalNeededEmailParams {
  email: string;
  firstName?: string | null;
  agentName?: string | null;
  /** Catalog agent type (hermes_instances.agent_type) — resolves the display name. */
  agentType?: string | null;
  instanceId: string;
  /** The redacted command/summary the agent is asking to run, if available. */
  summary?: string | null;
  kind?: "approval" | "clarify";
  idempotencyKey: string;
}

export type AgentApprovalNeededSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const LOG_SOURCE = "agent-approval-needed-email";

function consoleUrl(instanceId: string): string {
  return `${SITE_URL}/dashboard/instances/${instanceId}/console`;
}

function greeting(firstName?: string | null): string {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

// "your agent \"Name\"" when named; else the catalog display name for the agent
// type; else a neutral "your agent". Never hardcodes "Hermes".
function agentLabel(agentName?: string | null, agentType?: string | null): string {
  if (agentName?.trim()) return `your agent "${agentName.trim()}"`;
  const typeName = agentType ? getAgent(agentType)?.name : undefined;
  return typeName ? `your ${typeName} agent` : "your agent";
}

function agentLabelCapitalized(agentName?: string | null, agentType?: string | null): string {
  const label = agentLabel(agentName, agentType);
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
}): Promise<AgentApprovalNeededSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping agent-approval-needed email", {
      source: LOG_SOURCE,
      to: opts.to,
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
      log.warn("agent-approval-needed email Resend send failed", {
        source: LOG_SOURCE,
        to: opts.to,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("agent-approval-needed email Resend threw", {
      source: LOG_SOURCE,
      to: opts.to,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}

export async function sendAgentApprovalNeededEmail(
  params: AgentApprovalNeededEmailParams
): Promise<AgentApprovalNeededSendResult> {
  const isClarify = params.kind === "clarify";
  const labelCap = agentLabelCapitalized(params.agentName, params.agentType);
  const url = consoleUrl(params.instanceId);
  const ask = isClarify
    ? "needs an answer from you before it can keep going"
    : "wants your approval before it runs a command";

  const subject = isClarify
    ? `${labelCap} needs your answer to continue`
    : `${labelCap} needs your approval to continue`;

  const summaryText = params.summary?.trim();
  const text = [
    greeting(params.firstName),
    "",
    `${labelCap} ${ask}, and it's paused waiting for you.`,
    ...(summaryText ? ["", `It's asking about:`, `  ${summaryText}`] : []),
    "",
    "Open the workspace to review and respond — it'll pick up right where it left off:",
    url,
    "",
    "If you don't respond, the agent will stop waiting after a while and skip the step, so it's worth a quick look.",
    "",
    "— Ash",
    "Founder, Hivra",
  ].join("\n");

  const summaryHtml = summaryText
    ? `<p style="margin:0 0 20px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:#1a1a1a;background:#f5f1e8;border:1px solid #e7e2d6;border-radius:4px;padding:12px 14px;">${escapeHtml(summaryText)}</p>`
    : "";

  const html = shellHtml({
    preheader: `${labelCap} is paused and waiting for you to respond.`,
    eyebrow: isClarify ? "Waiting for your answer" : "Waiting for your approval",
    title: `${labelCap} needs you.`,
    body: `
      <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${greeting(params.firstName)}</p>
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">${labelCap} ${ask}, and it's paused waiting for you.</p>
      ${summaryHtml}
      <p style="margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;">Open the workspace to review and respond — it picks up right where it left off.</p>
    `,
    ctaText: "Review in workspace",
    ctaUrl: url,
    footerNote:
      "If you don't respond, the agent stops waiting after a while and skips the step. Reply to this email if anything's unclear. — Ash",
  });

  return send({ to: params.email, subject, text, html, idempotencyKey: params.idempotencyKey });
}
