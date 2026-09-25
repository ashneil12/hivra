/**
 * "Your withdrawal destination changed" email.
 *
 * Sent to the account's primary email whenever a place Hivra withdraws funds
 * to changes: the lock wallet's withdraw address, an agent wallet's
 * withdrawal destination, or the verified wallet a lock-wallet move goes to.
 * The new destination cannot receive anything for
 * WITHDRAW_DESTINATION_COOLDOWN_MS; this email is how the owner learns about a
 * change they did not make while there is still time to stop it.
 *
 * Best-effort: the change is already saved when this runs, and the cooldown
 * protects the funds whether or not the email lands. It never throws; callers
 * log a result that was not sent.
 */

import { Resend } from "resend";
import { clerkClient } from "@clerk/nextjs/server";

import { resolveFromEmail, resolveReplyToEmail } from "@/lib/email/config";
import { withdrawDestinationCooldownHours } from "@/lib/billing/withdraw-destination-policy";
import { SITE_URL } from "@/lib/seo-urls";

export type WithdrawDestinationKind = "lock_wallet" | "agent_wallet" | "verified_wallet";

export interface WithdrawDestinationChangedParams {
  userId: string;
  kind: WithdrawDestinationKind;
  /** The wallet funds leave from (an agent wallet's own address), when known. */
  walletAddress?: string | null;
  previousAddress: string | null;
  newAddress: string;
  changedAt: Date;
  /** When the new destination can first receive funds. */
  availableAt: Date;
}

export type WithdrawDestinationChangedSendResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "no_email" | "send_failed"; errorMessage?: string };

export type WithdrawDestinationNotifier = (
  params: WithdrawDestinationChangedParams
) => Promise<WithdrawDestinationChangedSendResult>;

function walletUrl(): string {
  return `${process.env.NEXT_PUBLIC_APP_URL?.trim() || SITE_URL}/dashboard/wallet`;
}

function describeDestination(params: WithdrawDestinationChangedParams): { subject: string; what: string } {
  if (params.kind === "lock_wallet") {
    return {
      subject: "Your Hivra withdraw address changed",
      what: "The withdraw address for your Hivra deposit wallet",
    };
  }
  if (params.kind === "verified_wallet") {
    return {
      subject: "A new wallet was verified on your Hivra account",
      what: "The verified wallet that your Hivra deposit wallet can move tokens to",
    };
  }
  return {
    subject: "An agent wallet's withdrawal destination changed",
    what: params.walletAddress
      ? `The withdrawal destination for your agent wallet ${params.walletAddress}`
      : "The withdrawal destination for one of your agent wallets",
  };
}

export function buildWithdrawDestinationChangedEmail(params: WithdrawDestinationChangedParams): {
  subject: string;
  text: string;
} {
  const { subject, what } = describeDestination(params);
  const hours = withdrawDestinationCooldownHours();
  return {
    subject,
    text: [
      `Hi,`,
      ``,
      `${what} changed on ${params.changedAt.toUTCString()}.`,
      ``,
      `New address: ${params.newAddress}`,
      `Previous address: ${params.previousAddress ?? "none"}`,
      ``,
      `For your safety, nothing can be sent to the new address for ${hours} hours. It can receive withdrawals from ${params.availableAt.toUTCString()}.`,
      ``,
      `If you made this change, you don't need to do anything.`,
      ``,
      `If you didn't, someone may have access to your account. Before that time: sign out of all sessions and change your password or sign-in method, then set the address back on your wallet page and reply to this email so we can help.`,
      ``,
      `Your wallet page: ${walletUrl()}`,
      ``,
      `— Hivra`,
    ].join("\n"),
  };
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    return user?.primaryEmailAddress?.emailAddress ?? user?.emailAddresses?.[0]?.emailAddress ?? null;
  } catch {
    return null;
  }
}

export const sendWithdrawDestinationChangedEmail: WithdrawDestinationNotifier = async (params) => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "not_configured" };

  const email = await resolveUserEmail(params.userId);
  if (!email) return { sent: false, reason: "no_email" };

  const { subject, text } = buildWithdrawDestinationChangedEmail(params);
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      { from: resolveFromEmail(), to: email, replyTo: resolveReplyToEmail(), subject, text },
      // One email per change, even if the request is retried.
      { idempotencyKey: `withdraw-destination:${params.userId}:${params.kind}:${params.newAddress}:${params.changedAt.toISOString()}` }
    );
    if (error) return { sent: false, reason: "send_failed", errorMessage: error.message };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: "send_failed", errorMessage: err instanceof Error ? err.message : String(err) };
  }
};
