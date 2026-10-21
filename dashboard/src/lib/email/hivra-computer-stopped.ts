/**
 * "Your computer was stopped" email.
 *
 * One plain email, sent after the unpaid-owner sweep stops a Hivra Cloud
 * computer (lib/recovery/hivra-lapse-enforce.ts). It says why, that nothing
 * was deleted, and what to do. It makes no promise about deletion.
 *
 * Best-effort: the computer is already stopped when this runs, so it never
 * throws and a failure never undoes the stop.
 */

import { Resend } from "resend";
import { clerkClient } from "@clerk/nextjs/server";

import { resolveFromEmail, resolveReplyToEmail } from "@/lib/email/config";
import { SITE_URL } from "@/lib/seo-urls";

export interface HivraComputerStoppedParams {
  userId: string;
  agentId: string;
  computerName?: string | null;
}

export type HivraComputerStoppedSendResult =
  | { sent: true }
  | { sent: false; reason: "not_configured" | "no_email" | "send_failed"; errorMessage?: string };

const SUBJECT = "Your Hivra computer was stopped";

export function buildHivraComputerStoppedEmail(params: Pick<HivraComputerStoppedParams, "computerName">): { subject: string; text: string } {
  const name = params.computerName?.trim();
  return {
    subject: SUBJECT,
    text: [
      "Hi,",
      "",
      `Your Hivra computer${name ? ` "${name}"` : ""} was stopped because it needs a paid plan and your account has none right now. A payment may not have gone through, or your plan may have ended.`,
      "",
      "Nothing was deleted. Your files are still on the computer.",
      "",
      "To use it again, fix your billing or choose a plan, then press Start on the computer.",
      "",
      `Billing: ${SITE_URL}/dashboard/billing`,
      "",
      "Hivra",
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

export async function sendHivraComputerStoppedEmail(params: HivraComputerStoppedParams): Promise<HivraComputerStoppedSendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: "not_configured" };

  const email = await resolveUserEmail(params.userId);
  if (!email) return { sent: false, reason: "no_email" };

  const { subject, text } = buildHivraComputerStoppedEmail(params);
  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send(
      { from: resolveFromEmail(), to: email, replyTo: resolveReplyToEmail(), subject, text },
      // One email per stop, even if the sweep retries within Resend's window.
      { idempotencyKey: `hivra-computer-stopped/${params.agentId}/${new Date().toISOString().slice(0, 10)}` },
    );
    if (error) return { sent: false, reason: "send_failed", errorMessage: error.message };
    return { sent: true };
  } catch (err) {
    return { sent: false, reason: "send_failed", errorMessage: err instanceof Error ? err.message : String(err) };
  }
}
