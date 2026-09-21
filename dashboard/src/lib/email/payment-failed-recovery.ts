/**
 * Failed-payment (dunning) recovery email — Resend integration.
 *
 * One customer-facing email, triggered by the Stripe invoice.payment_failed
 * webhook (see lib/billing/dunning.ts for the trigger/skip/dedupe logic —
 * this module only knows how to build and send the email). Copy approved by
 * Ash 2026-07-07; treat it as verbatim.
 *
 * Deliberately NOT the branded card shell the other lifecycle emails use:
 * dunning recovers best as a short personal note from a human, so the HTML
 * is a minimal wrapper (same font stack + paragraph styling as
 * email/lifecycle.ts, no eyebrow/CTA chrome) around the plain-text copy.
 *
 * Sender: this email intentionally comes from "Ash at Hivra
 * <info@EMAIL_SEND_DOMAIN>" (the monitored inbox) rather than the shared
 * noreply@ envelope-from — "just reply and tell me" only works if replies
 * actually land somewhere Ash reads. Transactional billing notice, so no
 * List-Unsubscribe headers (those are for the marketing-adjacent lifecycle
 * sends).
 *
 * Idempotency: callers pass the invoice-keyed ledger key
 * (payment_failed_recovery_<invoice_id>) as the Resend idempotencyKey, so
 * even a ledger-write race can't double-send within Resend's dedupe window.
 */

import { Resend } from "resend";

import { EMAIL_SEND_DOMAIN, resolveReplyToEmail } from "@/lib/email/config";
import { escapeHtml } from "@/lib/email/escape-html";
import { log } from "@/lib/logger";

const LOG_SOURCE = "payment-failed-recovery-email";

/** Ledger/idempotency key for a given failed invoice — at most once per invoice, ever. */
export function paymentFailedRecoveryEmailKey(invoiceId: string): string {
  return `payment_failed_recovery_${invoiceId}`;
}

/**
 * Personal sender for THIS email only. Pinned to the verified send domain
 * (see email/config.ts) but not to RESEND_FROM_EMAIL — the whole point is
 * that it isn't a noreply.
 */
export const PAYMENT_FAILED_RECOVERY_FROM = `Ash at Hivra <info@${EMAIL_SEND_DOMAIN}>`;

/**
 * First token of the Stripe customer name, capitalized, falling back to
 * "there" ("Hey there,") when Stripe has no usable name.
 */
export function firstNameFromCustomerName(name?: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? "";
  if (!first) return "there";
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export interface PaymentFailedRecoveryEmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface PaymentFailedRecoveryEmailParams {
  /** Already-derived greeting name (see firstNameFromCustomerName). */
  firstName: string;
  /** Stripe hosted invoice page — pays without a dashboard login. */
  hostedInvoiceUrl: string;
}

export type PaymentFailedRecoveryEmailSendResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "not_configured" | "send_failed"; errorMessage?: string };

const PARAGRAPH_STYLE = "margin:0 0 20px;font-size:16px;line-height:1.6;color:#1a1a1a;";

/** Exported for tests and previews; sendPaymentFailedRecoveryEmail uses it internally. */
export function buildPaymentFailedRecoveryEmail(
  params: PaymentFailedRecoveryEmailParams
): PaymentFailedRecoveryEmailContent {
  const subject = "your agent hit a card snag";
  const text = [
    `Hey ${params.firstName},`,
    "",
    "Quick heads up. Your card didn't go through this month, so this cycle's payment failed.",
    "",
    "Your agent is still running. Its memory, chats, and everything it's set up for you are safe. But if the card keeps failing, the box gets shut down automatically and all of that goes with it.",
    "",
    "The fix takes 30 seconds, no login needed:",
    "",
    params.hostedInvoiceUrl,
    "",
    "Money tight or meant to cancel? Just reply and tell me. I read every email.",
    "",
    "Ash",
    "Founder, Hivra",
  ].join("\n");

  const sans = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  const p = (content: string) => `<p style="${PARAGRAPH_STYLE}">${content}</p>`;
  const safeUrl = escapeHtml(params.hostedInvoiceUrl);
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>${subject}</title></head>
  <body style="margin:0;padding:0;background:#ffffff;font-family:${sans};color:#1a1a1a;-webkit-font-smoothing:antialiased;">
    <div style="max-width:560px;margin:0 auto;padding:32px 20px;">
      ${p(`Hey ${escapeHtml(params.firstName)},`)}
      ${p("Quick heads up. Your card didn't go through this month, so this cycle's payment failed.")}
      ${p("Your agent is still running. Its memory, chats, and everything it's set up for you are safe. But if the card keeps failing, the box gets shut down automatically and all of that goes with it.")}
      ${p("The fix takes 30 seconds, no login needed:")}
      ${p(`<a href="${safeUrl}" style="color:#b3261e;word-break:break-all;">${safeUrl}</a>`)}
      ${p("Money tight or meant to cancel? Just reply and tell me. I read every email.")}
      <p style="margin:0;font-size:16px;line-height:1.6;color:#1a1a1a;">Ash<br />Founder, Hivra</p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendPaymentFailedRecoveryEmail(params: {
  email: string;
  firstName: string;
  hostedInvoiceUrl: string;
  idempotencyKey: string;
}): Promise<PaymentFailedRecoveryEmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.warn("RESEND_API_KEY not configured; skipping payment-failed recovery email", {
      source: LOG_SOURCE,
      to: params.email,
    });
    return { sent: false, reason: "not_configured" };
  }
  const content = buildPaymentFailedRecoveryEmail({
    firstName: params.firstName,
    hostedInvoiceUrl: params.hostedInvoiceUrl,
  });
  try {
    const resend = new Resend(apiKey);
    // NOTE on suppression: there's no in-repo suppression list yet (see the
    // note in email/config.ts) — Resend enforces its own suppression list at
    // accept time, so sends to hard-bounced/suppressed addresses come back as
    // an error here and are counted as send_failed rather than delivered.
    const { data, error } = await resend.emails.send(
      {
        from: PAYMENT_FAILED_RECOVERY_FROM,
        to: params.email,
        replyTo: resolveReplyToEmail(),
        subject: content.subject,
        text: content.text,
        html: content.html,
      },
      { idempotencyKey: params.idempotencyKey }
    );
    if (error) {
      log.warn("payment-failed recovery email Resend send failed", {
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
    log.warn("payment-failed recovery email Resend threw", {
      source: LOG_SOURCE,
      to: params.email,
      errorMessage: msg,
    });
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
