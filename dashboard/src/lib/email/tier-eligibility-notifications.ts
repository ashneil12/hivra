/**
 * Email notifications for tier-eligibility transitions.
 *
 * Wired into `refresh-token-holdings` cron. After the eligibility evaluator
 * records a state change for a user (`qualified`, `breached`, `re_qualified`),
 * the cron calls this helper to send the user a plain-text email explaining
 * what happened to their tier eligibility.
 *
 * Best-effort and non-blocking. If RESEND_API_KEY is not set or the user's
 * email cannot be resolved, the helper logs and returns — eligibility state
 * is the truth, emails are advisory.
 */

import { Resend } from "resend";
import { clerkClient } from "@clerk/nextjs/server";

import {
  HERMESOS_TOKEN_DECIMALS,
  HERMESOS_TOKEN_SYMBOL,
} from "@/lib/billing/token-holdings";
import type {
  EligibilityResult,
  EligibilityTransition,
  TierKey,
} from "@/lib/billing/token-tier-eligibility";

interface SendParams {
  userId: string;
  tier: TierKey;
  transition: EligibilityTransition;
  currentBalance: bigint;
  evaluation: EligibilityResult;
}

interface SendResult {
  sent: boolean;
  reason?: "not_configured" | "no_email" | "send_failed" | "skipped";
  errorMessage?: string;
}

/**
 * Format a base-units bigint as a human-readable token amount.
 * 250000000000000000000n with 18 decimals → "250"
 */
export function formatTokenAmount(raw: bigint, decimals = HERMESOS_TOKEN_DECIMALS): string {
  if (decimals === 0) return raw.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = raw / divisor;
  const frac = raw % divisor;
  if (frac === 0n) return whole.toLocaleString("en-US");
  // Trim trailing zeros on the fractional part for readability.
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fracStr === "") return whole.toLocaleString("en-US");
  // Show at most 4 decimals so emails read cleanly.
  const trimmed = fracStr.slice(0, 4);
  return `${whole.toLocaleString("en-US")}.${trimmed}`;
}

function tierLabel(tier: TierKey): string {
  return tier === "pro" ? "Pro" : "Power";
}

interface EmailContent {
  subject: string;
  text: string;
}

function buildEmailContent(params: SendParams): EmailContent | null {
  const tierName = tierLabel(params.tier);
  const sym = HERMESOS_TOKEN_SYMBOL;
  const balanceStr = formatTokenAmount(params.currentBalance);
  const tierEval = params.tier === "pro" ? params.evaluation.pro : params.evaluation.power;
  if (!tierEval) return null;

  const qualifyingStr = tierEval.qualifyingQuantity
    ? formatTokenAmount(tierEval.qualifyingQuantity)
    : "—";
  const thresholdStr = tierEval.threshold !== null ? formatTokenAmount(tierEval.threshold) : "the current threshold";

  if (params.transition === "qualified") {
    return {
      subject: `You qualified for the ${tierName} tier`,
      text: [
        `Your wallet now holds ${balanceStr} ${sym}, which qualifies you for the Hivra ${tierName} tier.`,
        ``,
        `Qualifying quantity: ${qualifyingStr} ${sym}.`,
        ``,
        `If your balance drops below ${qualifyingStr} ${sym}, your eligibility ends after a grace period. You can withdraw any time, and if you re-deposit later, your qualifying quantity will be set to whatever the threshold is at that point.`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "breached") {
    return {
      subject: `Your $${sym} balance dropped below your qualifying quantity`,
      text: [
        `Your wallet now holds ${balanceStr} ${sym}. Your qualifying quantity for the ${tierName} tier was ${qualifyingStr} ${sym}.`,
        ``,
        `Your ${tierName} tier eligibility has ended. To regain ${tierName}, deposit back to at least the current threshold of ${thresholdStr} ${sym}. (Note: re-qualifying uses the current threshold, not your original qualifying quantity.)`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "re_qualified") {
    return {
      subject: `You re-qualified for the ${tierName} tier`,
      text: [
        `Your wallet now holds ${balanceStr} ${sym}. You're back on the Hivra ${tierName} tier.`,
        ``,
        `New qualifying quantity: ${qualifyingStr} ${sym} (set at today's threshold).`,
        ``,
        `If your balance drops below ${qualifyingStr} ${sym}, your eligibility ends after a grace period.`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "grace_recovered") {
    return {
      subject: `Your ${tierName} tier is back to active`,
      text: [
        `Your wallet now holds ${balanceStr} ${sym}, back above your qualifying quantity of ${qualifyingStr} ${sym}.`,
        ``,
        `Your ${tierName} tier eligibility is active again. No action needed — you're still grandfathered at your original qualifying quantity.`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "suspended") {
    const cooldownStr = tierEval.cooldownEndsAt
      ? new Date(tierEval.cooldownEndsAt).toUTCString()
      : null;
    return {
      subject: `Your ${tierName} tier eligibility has been suspended`,
      text: [
        `Your wallet holds ${balanceStr} ${sym}. Your qualifying quantity for the ${tierName} tier was ${qualifyingStr} ${sym}, and the 48-hour grace period has elapsed without your balance returning above that threshold.`,
        ``,
        `Your ${tierName} tier is now suspended.`,
        ``,
        cooldownStr
          ? `A 7-day cooldown applies before you can re-qualify. Cooldown ends: ${cooldownStr}.`
          : `A 7-day cooldown applies before you can re-qualify.`,
        ``,
        `When the cooldown ends, depositing back to the current threshold of ${thresholdStr} ${sym} will re-qualify you at the current rate. (Note: this means launch-rate holders who re-qualify after the launch promo window pay the standard threshold from then on.)`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "requalification_blocked_cooldown") {
    const cooldownStr = tierEval.cooldownEndsAt
      ? new Date(tierEval.cooldownEndsAt).toUTCString()
      : null;
    return {
      subject: `${tierName} re-qualification on hold during cooldown`,
      text: [
        `Your wallet holds ${balanceStr} ${sym}, which is above the current ${tierName} threshold of ${thresholdStr} ${sym}. However, you're inside the 7-day cooldown period from your previous suspension.`,
        ``,
        cooldownStr
          ? `Cooldown ends: ${cooldownStr}. After that, your balance will re-qualify you automatically on the next cron tick.`
          : `Cooldown will expire shortly. After that, your balance will re-qualify you automatically on the next cron tick.`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  if (params.transition === "requalification_blocked_cap") {
    return {
      subject: `${tierName} re-qualification cap reached`,
      text: [
        `Your wallet holds ${balanceStr} ${sym}, which is above the current ${tierName} threshold. However, you've already re-qualified twice in the past 12 months and re-qualification is capped at two per rolling year.`,
        ``,
        `Your eligibility will resume once you're outside the 12-month window from your first re-qualification. We're happy to discuss edge cases — reply to this email and we'll take a look.`,
        ``,
        `View your wallet: https://hermesos.cloud/dashboard/wallet`,
      ].join("\n"),
    };
  }

  return null;
}

async function resolveUserEmail(userId: string): Promise<string | null> {
  try {
    const clerk = await clerkClient();
    const user = await clerk.users.getUser(userId);
    const primary =
      user.primaryEmailAddress?.emailAddress ||
      user.emailAddresses?.[0]?.emailAddress ||
      null;
    return primary;
  } catch {
    return null;
  }
}

export async function sendTierEligibilityNotification(
  params: SendParams
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.RESEND_FROM_EMAIL ?? "noreply@hermesos.cloud";

  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      `[TierEligibility] RESEND_API_KEY not configured; skipping ${params.transition} email for ${params.userId}/${params.tier}`
    );
    return { sent: false, reason: "not_configured" };
  }

  const content = buildEmailContent(params);
  if (!content) {
    // Defensive — the cron filters out 'unchanged' before calling, but
    // if a future caller passes through an unmapped transition, log and
    // skip rather than throw.
    return { sent: false, reason: "skipped" };
  }

  const email = await resolveUserEmail(params.userId);
  if (!email) {
    // eslint-disable-next-line no-console
    console.warn(
      `[TierEligibility] no email for user ${params.userId}; skipping ${params.transition}`
    );
    return { sent: false, reason: "no_email" };
  }

  try {
    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: fromAddress,
      to: email,
      subject: content.subject,
      text: content.text,
    });

    if (error) {
      // eslint-disable-next-line no-console
      console.error(
        `[TierEligibility] resend send failed user=${params.userId} tier=${params.tier} transition=${params.transition}: ${error.message}`
      );
      return { sent: false, reason: "send_failed", errorMessage: error.message };
    }

    return { sent: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(
      `[TierEligibility] resend threw user=${params.userId} tier=${params.tier} transition=${params.transition}: ${msg}`
    );
    return { sent: false, reason: "send_failed", errorMessage: msg };
  }
}
