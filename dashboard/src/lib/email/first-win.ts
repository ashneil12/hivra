/**
 * First-win nudge emails.
 *
 * Two one-time emails that point a new account at its first win (the first
 * message sent to an agent). Both reuse the lifecycle email shell, sender and
 * unsubscribe headers. Send-at-most-once bookkeeping lives in the
 * lifecycle_email_sends ledger, driven by recovery/first-win-email-sweep.
 *
 * Copy: plain, warm, short. A free account has no hosted compute, so its
 * launch email only points at Launch and never offers a free server.
 */

import { Resend } from "resend";

import { lifecycleUnsubscribeHeaders, resolveFromEmail, resolveReplyToEmail } from "@/lib/email/config";
import {
  escapeHtml,
  greeting,
  htmlGreeting,
  htmlParagraph,
  shellHtml,
  type LifecycleEmailContent,
} from "@/lib/email/lifecycle";
import { log } from "@/lib/logger";
import { SITE_URL } from "@/lib/seo-urls";

export const FIRST_WIN_EMAIL_KEYS = ["first_win_launch", "first_win_say_hi"] as const;
export type FirstWinEmailKey = (typeof FIRST_WIN_EMAIL_KEYS)[number];

export type FirstWinLaunchProfile = "hermes" | "claude-code";

export interface FirstWinEmailParams {
  firstName?: string | null;
  /** first_win_launch: the agent to open in Launch. */
  profile?: FirstWinLaunchProfile;
  /** first_win_launch: true when the account is on a paid plan. */
  paid?: boolean;
  /** first_win_say_hi: the agent's name and the page to open. */
  agentName?: string | null;
  agentUrl?: string | null;
}

export type FirstWinEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const LOG_SOURCE = "first-win-email";

export function firstWinLaunchUrl(profile: FirstWinLaunchProfile): string {
  return `${SITE_URL}/dashboard/launch?profile=${profile}`;
}

function buildLaunch(params: FirstWinEmailParams): LifecycleEmailContent {
  const profile = params.profile ?? "claude-code";
  const ctaUrl = firstWinLaunchUrl(profile);
  const subject = "Your first agent is one click away";
  const intro = params.paid
    ? "Your plan is ready, and your first agent is one click away. It takes about two minutes, and you can ask it for something real right after."
    : "Your first agent is one click away. Connect a server you already have, and you can ask it for something real in a couple of minutes.";
  const text = [
    greeting(params.firstName),
    "",
    intro,
    "",
    `Start here: ${ctaUrl}`,
    "",
    "If something got in the way, just reply. I read every reply.",
    "",
    "Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "It takes about two minutes.",
    eyebrow: "Getting started",
    title: "Your first agent is one click away.",
    body: [htmlGreeting(params.firstName), htmlParagraph(escapeHtml(intro))].join("\n"),
    ctaText: "Launch your agent",
    ctaUrl,
    footerNote: "If something got in the way, just reply. I read every reply. Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

function buildSayHi(params: FirstWinEmailParams): LifecycleEmailContent {
  const name = params.agentName?.trim() || "Your agent";
  const ctaUrl = params.agentUrl || `${SITE_URL}/dashboard`;
  const subject = "Your agent is ready. Say hi.";
  const intro = `${name} is up and waiting. Open it and send a first message. Something small is fine, like "what can you help me with?".`;
  const text = [
    greeting(params.firstName),
    "",
    intro,
    "",
    `Open it here: ${ctaUrl}`,
    "",
    "Ash",
    "Founder, Hivra",
  ].join("\n");
  const html = shellHtml({
    preheader: "A first message is all it takes.",
    eyebrow: "Ready",
    title: "Your agent is ready. Say hi.",
    body: [htmlGreeting(params.firstName), htmlParagraph(escapeHtml(intro))].join("\n"),
    ctaText: "Open your agent",
    ctaUrl,
    footerNote: "Reply if anything is unclear. I read every reply. Ash, Founder, Hivra",
  });
  return { subject, text, html, ctaUrl };
}

export function buildFirstWinEmail(key: FirstWinEmailKey, params: FirstWinEmailParams): LifecycleEmailContent {
  return key === "first_win_launch" ? buildLaunch(params) : buildSayHi(params);
}

export async function sendFirstWinEmail(
  key: FirstWinEmailKey,
  params: FirstWinEmailParams & { email: string; idempotencyKey: string },
): Promise<FirstWinEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping first-win email", { source: LOG_SOURCE, emailKey: key });
    return { sent: false, reason: "not_configured" };
  }
  const content = buildFirstWinEmail(key, params);
  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send(
      {
        from: resolveFromEmail(),
        to: params.email,
        replyTo: resolveReplyToEmail(),
        subject: content.subject,
        text: content.text,
        html: content.html,
        headers: lifecycleUnsubscribeHeaders(),
      },
      { idempotencyKey: params.idempotencyKey },
    );
    if (error) {
      log.warn("first-win email Resend send failed", {
        source: LOG_SOURCE,
        emailKey: key,
        errorName: error.name,
        errorMessage: error.message,
      });
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true, messageId: data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn("first-win email Resend threw", { source: LOG_SOURCE, emailKey: key, errorMessage: msg });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
