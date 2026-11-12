/**
 * Hermes move emails.
 *
 * Old Hermes agents are moved automatically onto the official Hermes. Owners
 * get two plain emails: one the day before ("moves tomorrow, nothing to do")
 * and one after ("it has moved, and how to update it").
 *
 * Best-effort: never throws. Returns { sent: false, reason } when email is not
 * configured, the owner has no verified email, or sending fails.
 */

import { Resend } from "resend";
import { clerkClient } from "@clerk/nextjs/server";

import { resolveFromEmail, resolveReplyToEmail } from "@/lib/email/config";
import { escapeHtml } from "@/lib/email/escape-html";
import { pickVerifiedSdkEmail } from "@/lib/email/clerk-verified-email";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

export type HermesMoveSendResult = { sent: boolean; reason?: string };

/** "12 November 2026, 14:30 UTC". Falls back to the raw string if unparseable. */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

interface Built { subject: string; text: string; html: string }

function wrapHtml(subject: string, paragraphs: string[]): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#1a1a1a;">${p}</p>`).join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:24px 16px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <div style="max-width:560px;margin:0 auto;">
${body}
    </div>
  </body>
</html>`;
}

export function buildHermesMoveNoticeEmail(p: { agentName: string; moveAfter: string }): Built {
  const name = p.agentName;
  const date = formatUtc(p.moveAfter);
  const subject = `Your agent ${name} moves to the official Hermes tomorrow`;
  const lines = [
    `Your agent ${name} moves to the official Hermes after ${date}.`,
    "Every Hermes agent on Hivra is moving so it can keep getting updates straight from Hermes. Your chats, memory, skills, settings, scheduled tasks, chat channels and files come with it.",
    "It is offline for about 15 minutes while it moves. You don't need to do anything.",
    "Your current computer is kept for 7 days, so the move can be undone from the agent's Settings.",
  ];
  const text = ["Hi,", "", ...lines.flatMap((l) => [l, ""]), "Hivra"].join("\n");
  const html = wrapHtml(subject, [
    "Hi,",
    `Your agent <strong>${escapeHtml(name)}</strong> moves to the official Hermes after ${escapeHtml(date)}.`,
    escapeHtml(lines[1]),
    escapeHtml(lines[2]),
    escapeHtml(lines[3]),
    "Hivra",
  ]);
  return { subject, text, html };
}

export function buildHermesMovedEmail(p: { agentName: string; agentId: string; undoUntil: string }): Built {
  const name = p.agentName;
  const date = formatUtc(p.undoUntil);
  const url = `${SITE_URL}/dashboard/agent/${encodeURIComponent(p.agentId)}`;
  const subject = `${name} has moved to the official Hermes`;
  const l0 = `Your agent ${name} now runs the official Hermes. Everything came with it.`;
  const l1 = "You can update it whenever you like: open its terminal and run `hermes update`.";
  const l2 = `If anything looks wrong, you can undo the move from the agent's Settings until ${date}.`;
  const text = ["Hi,", "", l0, "", l1, "", l2, "", `Agent page: ${url}`, "", "Hivra"].join("\n");
  const html = wrapHtml(subject, [
    "Hi,",
    `Your agent <strong>${escapeHtml(name)}</strong> now runs the official Hermes. Everything came with it.`,
    "You can update it whenever you like: open its terminal and run <code>hermes update</code>.",
    `If anything looks wrong, you can undo the move from the agent's Settings until ${escapeHtml(date)}.`,
    `<a href="${escapeHtml(url)}">Open the agent's page</a>`,
    "Hivra",
  ]);
  return { subject, text, html };
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return pickVerifiedSdkEmail(user);
  } catch {
    return null;
  }
}

async function deliver(kind: string, userId: string, build: () => Built): Promise<HermesMoveSendResult> {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { sent: false, reason: "not_configured" };

    const email = await resolveUserEmail(userId);
    if (!email) return { sent: false, reason: "no_email" };

    const { subject, text, html } = build();
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({ from: resolveFromEmail(), to: email, replyTo: resolveReplyToEmail(), subject, text, html });
    if (error) {
      log.warn(`${kind} email Resend send failed`, { source: kind, failureType: "resend_send_failed", errorName: error.name, errorMessage: error.message });
      return { sent: false, reason: "send_failed" };
    }
    return { sent: true };
  } catch (err) {
    log.warn(`${kind} email Resend threw`, { source: kind, failureType: "resend_threw", errorMessage: err instanceof Error ? err.message : String(err) });
    return { sent: false, reason: "send_failed" };
  }
}

export async function sendHermesMoveNoticeEmail(p: { userId: string; agentName: string; moveAfter: string }): Promise<{ sent: boolean; reason?: string }> {
  return deliver("hermes-move-notice", p.userId, () => buildHermesMoveNoticeEmail(p));
}

export async function sendHermesMovedEmail(p: { userId: string; agentName: string; agentId: string; undoUntil: string }): Promise<{ sent: boolean; reason?: string }> {
  return deliver("hermes-moved", p.userId, () => buildHermesMovedEmail(p));
}
