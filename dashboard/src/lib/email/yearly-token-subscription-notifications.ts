/**
 * Email notifications for yearly token subscriptions.
 *
 * Two transitions matter:
 *   - "expiring_soon" — sent 7 days before expires_at; reminds the user
 *                       to renew if they want to keep their tier
 *   - "expired"      — sent when the 7-day grace closes; tier dropped
 *                       to Free
 *
 * Both emails are advisory: renewal and expiry happen on their dates
 * whether or not the email lands (the expiry cron retries undelivered
 * "ended" emails for a bounded window). Paying while the subscription is
 * active extends it by a year from its current end; paying during grace
 * runs a year from the payment. If RESEND_API_KEY is unset, we log and skip.
 */

import { Resend } from "resend";
import { clerkClient } from "@clerk/nextjs/server";

type YearlyTokenEmailTransition = "expiring_soon" | "expired";

interface SendParams {
  userId: string;
  tier: "pro" | "power";
  transition: YearlyTokenEmailTransition;
  expiresAt: Date;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "no_email" | "send_failed" | "skipped";
  errorMessage?: string;
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const primary =
      user?.primaryEmailAddress?.emailAddress ??
      user?.emailAddresses?.[0]?.emailAddress ??
      null;
    return primary;
  } catch {
    return null;
  }
}

function buildEmail(params: SendParams): { subject: string; body: string } {
  const tierLabel = params.tier === "power" ? "Power" : "Pro";
  const expiresLabel = params.expiresAt.toUTCString();
  // Deep link straight into the $HermesOS yearly payment for this tier: the
  // billing page opens the quote modal for it, including for a subscriber
  // whose current year is still live (renewal).
  const renewUrl = `${process.env.NEXT_PUBLIC_APP_URL ?? "https://hivra.cloud"}/dashboard/billing?plan=${params.tier}&yearly_token=1`;

  if (params.transition === "expiring_soon") {
    return {
      subject: `Your Hivra ${tierLabel} subscription expires in 7 days`,
      body: [
        `Hi,`,
        ``,
        `Your yearly $HermesOS-paid ${tierLabel} subscription expires on ${expiresLabel}.`,
        ``,
        `To keep ${tierLabel}, pay for another year with $HermesOS on /dashboard/billing. Paying before it expires adds a full year on top of your current end date, so you don't lose any days.`,
        ``,
        `There's also a 7-day grace window after expiry — your tier stays active during that time, and a payment made then runs for a year from the day you pay.`,
        ``,
        `Renew here: ${renewUrl}`,
        ``,
        `If you'd rather switch to a card subscription, the same page has Monthly / Yearly options.`,
        ``,
        `— Hivra`,
      ].join("\n"),
    };
  }

  return {
    subject: `Your Hivra ${tierLabel} subscription has ended`,
    body: [
      `Hi,`,
      ``,
      `Your yearly $HermesOS-paid ${tierLabel} subscription expired on ${expiresLabel} and the 7-day grace window has now closed. Your account has been moved back to the Free tier.`,
      ``,
      `Want to come back? You can pay with $HermesOS again, or switch to a card subscription on /dashboard/billing.`,
      ``,
      `Renew: ${renewUrl}`,
      ``,
      `— Hivra`,
    ].join("\n"),
  };
}

export async function sendYearlyTokenSubscriptionNotification(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[YearlyTokenSub] RESEND_API_KEY not configured; skipping ${params.transition} email for ${params.userId}/${params.tier}`
    );
    return { sent: false, reason: "not_configured" };
  }

  const email = await resolveUserEmail(params.userId);
  if (!email) {
    // eslint-disable-next-line no-console
    console.warn(
      `[YearlyTokenSub] no email for user ${params.userId}; skipping ${params.transition}`
    );
    return { sent: false, reason: "no_email" };
  }

  const { subject, body } = buildEmail(params);

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: email,
      subject,
      text: body,
    });
    if (error) {
      // eslint-disable-next-line no-console
      console.error(`[YearlyTokenSub] email send failed: ${error.message}`);
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }
    return { sent: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[YearlyTokenSub] email send threw: ${message}`);
    return { sent: false, reason: "send_failed", errorMessage: message };
  }
}
