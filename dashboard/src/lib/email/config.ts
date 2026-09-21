/**
 * Shared email-sender config.
 *
 * Centralizes the Resend "from"/"reply-to" addresses and the canonical
 * send domain so a future brand-domain cutover (hermesos.cloud → the new
 * brand domain) is a one-line change here instead of a grep-and-replace
 * across ~15 email modules.
 *
 * IMPORTANT: the value below is the domain currently verified in Resend
 * and live in production. Even though the product is mid-rebrand, the
 * email-sending domain has NOT been cut over yet (DNS/DKIM/SPF for the
 * new domain are not provisioned), so sending from anything else here
 * would hard-bounce. Change EMAIL_SEND_DOMAIN only once the new domain is
 * verified in Resend.
 */

/** The verified Resend sending domain. Single source of truth. */
export const EMAIL_SEND_DOMAIN = "hermesos.cloud";

/** Default envelope-from. Overridable via RESEND_FROM_EMAIL. */
const DEFAULT_FROM_EMAIL = `noreply@${EMAIL_SEND_DOMAIN}`;

/** Default reply-to (a real, monitored inbox). Overridable via RESEND_REPLY_TO_EMAIL. */
const DEFAULT_REPLY_TO_EMAIL = `info@${EMAIL_SEND_DOMAIN}`;

/** Resolve the envelope-from, honoring the env override. */
export function resolveFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL ?? DEFAULT_FROM_EMAIL;
}

/** Resolve the reply-to, honoring the env override. */
export function resolveReplyToEmail(): string {
  return process.env.RESEND_REPLY_TO_EMAIL ?? DEFAULT_REPLY_TO_EMAIL;
}

/**
 * RFC 8058 / RFC 2369 one-click-unsubscribe headers for lifecycle
 * (marketing-adjacent) email. We don't run a self-serve preference center
 * yet, so the mailto: form is the unsubscribe channel: a List-Unsubscribe
 * mailto plus List-Unsubscribe-Post lets Gmail/Apple Mail render a native
 * "Unsubscribe" affordance that posts to / mails the address. This both
 * improves deliverability reputation and gives recipients a real opt-out.
 *
 * NOTE: honoring these requests is currently manual (the mail lands in the
 * info@ inbox). Wiring an automated suppression list is the bounce-webhook
 * follow-up tracked alongside this change.
 */
export function lifecycleUnsubscribeHeaders(): Record<string, string> {
  const replyTo = resolveReplyToEmail();
  return {
    "List-Unsubscribe": `<mailto:${replyTo}?subject=unsubscribe>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
