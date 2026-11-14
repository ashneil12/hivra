/**
 * Feedback emails — Resend integration.
 *
 * Two plain, reply-to-answer emails from Ash, driven by the feedback-emails
 * cron (see lib/recovery/feedback-email-sweep.ts):
 *   feedback_checkin  a paying customer a couple of weeks in: what they use it
 *                     for, what gets in the way, who else should have it
 *   cancel_feedback   a customer who cancelled recently: what made them stop
 *
 * Answers arrive as replies in the reply-to inbox. There is no link to click:
 * the point is a reply, so the email reads like a note, not a campaign.
 * Send-at-most-once bookkeeping lives in lifecycle_email_sends.
 */

import { Resend } from "resend";

import {
  lifecycleUnsubscribeHeaders,
  resolveFromEmail,
  resolveReplyToEmail,
} from "@/lib/email/config";
import { escapeHtml } from "@/lib/email/escape-html";
import { log } from "@/lib/logger";

export const FEEDBACK_EMAIL_KEYS = ["feedback_checkin", "cancel_feedback"] as const;

export type FeedbackEmailKey = (typeof FEEDBACK_EMAIL_KEYS)[number];

export interface FeedbackEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface FeedbackEmailSendParams {
  email: string;
  firstName?: string | null;
  idempotencyKey: string;
}

export type FeedbackEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const LOG_SOURCE = "feedback-email";

function greeting(firstName?: string | null): string {
  return firstName?.trim() ? `Hey ${firstName.trim()},` : "Hey,";
}

const SIGN_OFF = ["Just hit reply. I read every one.", "", "— Ash", "Founder, Hivra"];

const COPY: Record<FeedbackEmailKey, { subject: string; lines: string[] }> = {
  feedback_checkin: {
    subject: "a quick question about Hivra",
    lines: [
      "You've been running Hivra for a few weeks, so I'd like to hear how it's going. Three questions, and one line each is plenty:",
      "",
      "1. What do you mostly use your agent for?",
      "2. What almost stopped you, or still gets in the way?",
      "3. Who else do you think should be using it?",
    ],
  },
  cancel_feedback: {
    subject: "what made you stop?",
    lines: [
      "I saw you cancelled your Hivra plan. This isn't a pitch to come back.",
      "",
      "I'd like to know what didn't work, so I can fix it for the next person. One line is plenty: what made you stop?",
    ],
  },
};

/** Exported for tests and previews; sendFeedbackEmail uses it internally. */
export function buildFeedbackEmail(
  key: FeedbackEmailKey,
  params: { firstName?: string | null }
): FeedbackEmailContent {
  const { subject, lines } = COPY[key];
  const textLines = [greeting(params.firstName), "", ...lines, "", ...SIGN_OFF];
  const text = textLines.join("\n");

  const paragraphs: string[] = [];
  let current: string[] = [];
  for (const line of textLines) {
    if (line === "") {
      if (current.length > 0) paragraphs.push(current.map(escapeHtml).join("<br>"));
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) paragraphs.push(current.map(escapeHtml).join("<br>"));
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1a1a1a;">${paragraphs
    .map((p) => `<p style="margin:0 0 14px;max-width:560px;">${p}</p>`)
    .join("")}</body></html>`;

  return { subject, text, html };
}

export async function sendFeedbackEmail(
  key: FeedbackEmailKey,
  params: FeedbackEmailSendParams
): Promise<FeedbackEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping feedback email", {
      source: LOG_SOURCE,
      emailKey: key,
    });
    return { sent: false, reason: "not_configured" };
  }
  const content = buildFeedbackEmail(key, params);
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
      { idempotencyKey: params.idempotencyKey }
    );
    if (error) {
      log.warn("feedback email Resend send failed", {
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
    log.warn("feedback email Resend threw", {
      source: LOG_SOURCE,
      emailKey: key,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
