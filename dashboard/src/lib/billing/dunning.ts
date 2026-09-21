/**
 * Dunning (failed-payment recovery) — trigger, skip, and dedupe logic.
 *
 * Called from StripeWebhookService.handlePaymentFailed on every
 * invoice.payment_failed event for a subscription invoice. Sends the
 * payment-failed recovery email (lib/email/payment-failed-recovery.ts)
 * AT MOST ONCE per invoice, with these skips:
 *
 *   - flag off            HERMES_DUNNING_EMAIL_ENABLED !== "true" (default OFF,
 *                         matching the other *_ENABLED sweep flags — set it in
 *                         Vercel to go live)
 *   - non-card invoices   collection_method !== "charge_automatically"
 *   - attempt 1           Stripe Smart Retries get one silent shot; we only
 *                         email from attempt_count >= 2 (Stripe increments
 *                         attempt_count per automatic retry)
 *   - already sent        lifecycle_email_sends ledger row keyed on the
 *                         invoice id (payment_failed_recovery_<invoice_id>),
 *                         so webhook redeliveries and later attempts for the
 *                         same invoice never double-mail
 *   - recovered           the invoice is re-fetched from Stripe right before
 *                         send; anything no longer `open` (paid / void /
 *                         uncollectible) is skipped
 *
 * Dedupe is two layers, same contract as the lifecycle sweep: ledger checked
 * before send + inserted after Resend accepts, with the invoice-keyed Resend
 * idempotencyKey as the backstop if the ledger write races or fails. A send
 * failure leaves no ledger row on purpose — the next attempt's
 * payment_failed event retries it, and "at most once" still holds.
 *
 * Suppressed/bounced addresses: there's no in-repo suppression list yet (see
 * email/config.ts) — Resend's own suppression list rejects those sends at
 * accept time, which surfaces here as send_failed, never as a delivery.
 */

import type Stripe from "stripe";

import {
  firstNameFromCustomerName,
  paymentFailedRecoveryEmailKey,
  sendPaymentFailedRecoveryEmail,
} from "@/lib/email/payment-failed-recovery";
import { log } from "@/lib/logger";
import { posthogClient } from "@/lib/posthog";
import { getStripe } from "@/lib/stripe";
import { supabaseAdmin } from "@/lib/supabase";

const LOG_SOURCE = "dunning-email";

/** Only email from the second failed attempt on (Smart Retries get one silent shot). */
const MIN_ATTEMPT_COUNT = 2;

/**
 * Master gate. Default OFF (codebase convention for new sweeps/sends);
 * set HERMES_DUNNING_EMAIL_ENABLED=true in Vercel to activate. Read at call
 * time so it can be flipped without a redeploy-triggered module reload.
 */
export function isDunningEmailEnabled(): boolean {
  return process.env.HERMES_DUNNING_EMAIL_ENABLED?.trim().toLowerCase() === "true";
}

type DunningEmailSkipReason =
  | "disabled"
  | "db_unavailable"
  | "missing_invoice_id"
  | "not_charge_automatically"
  | "first_attempt"
  | "ledger_check_failed"
  | "already_sent"
  | "invoice_lookup_failed"
  | "invoice_not_open"
  | "no_recipient"
  | "no_invoice_url"
  | "send_failed";

export type DunningEmailOutcome =
  | { sent: true }
  | { sent: false; reason: DunningEmailSkipReason };

/**
 * Send the payment-failed recovery email for a failed subscription invoice,
 * if (and only if) every gate above passes. Never throws for expected skip
 * paths; the caller still wraps it so an unexpected throw can't fail the
 * webhook and trigger a Stripe redelivery loop.
 */
export async function maybeSendPaymentFailedRecoveryEmail(params: {
  invoice: Stripe.Invoice;
  /** Clerk user id resolved from the subscription metadata by the caller. */
  userId: string;
}): Promise<DunningEmailOutcome> {
  const { invoice, userId } = params;

  if (!isDunningEmailEnabled()) return { sent: false, reason: "disabled" };
  if (!supabaseAdmin) return { sent: false, reason: "db_unavailable" };

  const invoiceId = invoice.id;
  if (!invoiceId) return { sent: false, reason: "missing_invoice_id" };

  if (invoice.collection_method !== "charge_automatically") {
    return { sent: false, reason: "not_charge_automatically" };
  }

  if ((invoice.attempt_count ?? 0) < MIN_ATTEMPT_COUNT) {
    return { sent: false, reason: "first_attempt" };
  }

  const emailKey = paymentFailedRecoveryEmailKey(invoiceId);

  // Ledger dedupe: at most once per invoice, ever. Fail closed on a read
  // error — a skipped email costs one nudge; a double-send costs trust.
  const { data: existing, error: ledgerErr } = await supabaseAdmin
    .from("lifecycle_email_sends")
    .select("id")
    .eq("user_id", userId)
    .eq("email_key", emailKey)
    .maybeSingle();
  if (ledgerErr) {
    log.warn("dunning ledger check failed; skipping send", {
      source: LOG_SOURCE,
      userId,
      invoiceId,
      errorMessage: ledgerErr.message,
    });
    return { sent: false, reason: "ledger_check_failed" };
  }
  if (existing) return { sent: false, reason: "already_sent" };

  // Freshness gate: anyone whose invoice got paid (or voided) between the
  // event and now must not be dunned. Also yields the freshest
  // hosted_invoice_url/customer fields.
  let fresh: Stripe.Invoice;
  try {
    fresh = await getStripe().invoices.retrieve(invoiceId);
  } catch (err) {
    log.warn("dunning invoice re-fetch failed; skipping send", {
      source: LOG_SOURCE,
      userId,
      invoiceId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, reason: "invoice_lookup_failed" };
  }
  if (fresh.status !== "open") return { sent: false, reason: "invoice_not_open" };

  const recipient = fresh.customer_email ?? invoice.customer_email ?? null;
  if (!recipient) return { sent: false, reason: "no_recipient" };

  const hostedInvoiceUrl = fresh.hosted_invoice_url ?? invoice.hosted_invoice_url ?? null;
  if (!hostedInvoiceUrl) return { sent: false, reason: "no_invoice_url" };

  const res = await sendPaymentFailedRecoveryEmail({
    email: recipient,
    firstName: firstNameFromCustomerName(fresh.customer_name ?? invoice.customer_name),
    hostedInvoiceUrl,
    idempotencyKey: emailKey,
  });
  if (!res.sent) return { sent: false, reason: "send_failed" };

  // Ledger write AFTER Resend accepts. If this fails, the invoice-keyed
  // Resend idempotencyKey still dedupes an immediate redelivery.
  const { error: insertErr } = await supabaseAdmin
    .from("lifecycle_email_sends")
    .upsert(
      { user_id: userId, email_key: emailKey },
      { onConflict: "user_id,email_key", ignoreDuplicates: true }
    );
  if (insertErr) {
    log.warn("dunning email sent but ledger insert failed", {
      source: LOG_SOURCE,
      userId,
      invoiceId,
      errorMessage: insertErr.message,
    });
  }

  log.info("payment-failed recovery email sent", {
    source: LOG_SOURCE,
    userId,
    invoiceId,
    attemptCount: invoice.attempt_count ?? null,
  });

  try {
    posthogClient.capture({
      distinctId: userId,
      event: "dunning_email_sent",
      properties: {
        invoice_id: invoiceId,
        attempt_count: invoice.attempt_count ?? null,
        $insert_id: emailKey,
      },
    });
    // Flush before the webhook function dies — Vercel won't wait for async
    // flushes (same pattern as the other webhook-side captures).
    await posthogClient.flush();
  } catch (err) {
    log.warn("dunning posthog capture failed", {
      source: LOG_SOURCE,
      userId,
      invoiceId,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }

  return { sent: true };
}
